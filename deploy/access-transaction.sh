#!/usr/bin/env bash
# Sourced by the installer after checkout, or by its root-owned installed copy.
# ADR-0015: stage a new origin without enabling it at boot. Only a verified
# passkey commits the active configuration; reboot during setup restores the old one.

ACCESS_GENERATION=""
ACCESS_PREVIOUS=""
ACCESS_TRANSACTION=false
ACCESS_COMMITTED=false
ACCESS_HAD_DROPIN=false

access_activate() {
  local generation="$1"
  ln -sfn "$generation" /etc/veduta/access/next || return 1
  mv -Tf /etc/veduta/access/next /etc/veduta/access/active
}

access_prepare() {
  install -d -o root -g root -m 0700 /etc/veduta/access
  ACCESS_GENERATION=$(mktemp -d /etc/veduta/access/config.XXXXXX)
  ACCESS_PREVIOUS=$(readlink /etc/veduta/access/active || true)
  local auth_state=/var/lib/veduta/auth.json
  local acme_dir=""
  if [ -f "$ACCESS_CONFIG" ]; then auth_state=$(jq -er '.authState' "$ACCESS_CONFIG"); fi
  if [ "$ACCESS_CHANGE" = true ]; then
    install -d -o veduta -g veduta -m 0700 /var/lib/veduta/access-auth
    auth_state="/var/lib/veduta/access-auth/${ACCESS_GENERATION##*/}.json"
  fi
  if [ "$ACCESS" = public ]; then
    if [ "$ORIGIN" = "$CURRENT_ORIGIN" ] && [ -f "$ACCESS_CONFIG" ]; then
      acme_dir=$(jq -r '.acmeDir // "/var/lib/veduta/.veduta/acme"' "$ACCESS_CONFIG")
    else
      # A new domain must never overwrite or reuse the old origin's certificate.
      acme_dir="/var/lib/veduta/access-acme/$DOMAIN"
    fi
    install -d -o veduta -g veduta -m 0700 "$acme_dir"
  fi
  BOOTSTRAP_CODE=$(head -c 9 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
  jq -n --arg mode "$ACCESS" --arg origin "$ORIGIN" --arg port "$ACCESS_PORT" \
    --arg sshTarget "$SSH_TARGET" --arg sshPort "$SSH_PORT" --arg domain "$DOMAIN" \
    --arg email "$EMAIL" --arg dataDir "$DATA_DIR" --arg authState "$auth_state" --arg acmeDir "$acme_dir" \
    '{mode:$mode, origin:$origin, port:($port|tonumber), sshTarget:$sshTarget,
      sshPort:($sshPort|tonumber), domain:$domain, email:$email, dataDir:$dataDir, authState:$authState, acmeDir:$acmeDir}' \
    >"$ACCESS_GENERATION/config.json"
  {
    printf 'VEDUTA_PROFILE=vps\nVEDUTA_ACCESS=%s\nPORT=%s\n' "$ACCESS" "$ACCESS_PORT"
    printf 'VEDUTA_PUBLIC_DOMAIN=%s\nVEDUTA_ACME_EMAIL=%s\n' "$DOMAIN" "$EMAIL"
    if [ -n "$acme_dir" ]; then printf 'VEDUTA_ACME_DIR=%s\n' "$acme_dir"; fi
    printf 'VEDUTA_DATA_DIR=%s\nVEDUTA_AUTH_STATE=%s\nVEDUTA_BOOTSTRAP_CODE=%s\n' "$DATA_DIR" "$auth_state" "$BOOTSTRAP_CODE"
  } >"$ACCESS_GENERATION/environment"
  chmod 0600 "$ACCESS_GENERATION/environment" "$ACCESS_GENERATION/config.json"

  if [ "$ACCESS_CHANGE" = true ]; then
    ACCESS_TRANSACTION=true
    if [ -f /etc/systemd/system/veduta.service.d/access.conf ]; then
      ACCESS_HAD_DROPIN=true
      cp /etc/systemd/system/veduta.service.d/access.conf "$ACCESS_GENERATION/previous-dropin"
    fi
    # /run is volatile, and this unit is never enabled. The normal unit retains
    # the old configuration until commit and remains enabled across reboot.
    systemctl cat veduta > /run/systemd/system/veduta-access-test.service
    cat >> /run/systemd/system/veduta-access-test.service <<EOF

[Unit]
Conflicts=veduta.service
OnFailure=veduta.service
OnSuccess=veduta.service

[Service]
EnvironmentFile=$ACCESS_GENERATION/environment
Environment=VEDUTA_ACCESS_PENDING=1
Restart=no
RuntimeMaxSec=900
EOF
    SERVICE_NAME=veduta-access-test
  else
    access_activate "$ACCESS_GENERATION"
    access_install_dropin
  fi
  systemctl daemon-reload
}

access_install_dropin() {
  printf '[Service]\nEnvironmentFile=/etc/veduta/access/active/environment\n' \
    > /etc/systemd/system/veduta.service.d/access.conf
  chmod 0644 /etc/systemd/system/veduta.service.d/access.conf
  ln -sfn /etc/veduta/access/active/config.json "$ACCESS_CONFIG"
}

access_commit() {
  if [ "$ACCESS_TRANSACTION" != true ]; then return 0; fi
  access_activate "$ACCESS_GENERATION"
  access_install_dropin
  systemctl daemon-reload
  systemctl stop veduta-access-test
  SERVICE_NAME=veduta
  systemctl restart veduta
  wait_for_gateway
  auth_status | jq -e '.mode == "production" and .passkeyRegistered == true' >/dev/null
  ACCESS_COMMITTED=true
  ACCESS_TRANSACTION=false
  rm -f /run/systemd/system/veduta-access-test.service
  systemctl daemon-reload
  printf 'Access change verified and saved.\n' >&2
}

access_restore_configuration() {
  # Explicit returns matter: the caller is an error handler, where Bash's
  # errexit is disabled. Never remove a candidate if restoring the old one fails.
  if [ -n "$ACCESS_PREVIOUS" ]; then
    access_activate "$ACCESS_PREVIOUS" || return 1
  else
    rm -f /etc/veduta/access/active "$ACCESS_CONFIG" || return 1
  fi
  if [ "$ACCESS_HAD_DROPIN" = true ]; then
    cp "$ACCESS_GENERATION/previous-dropin" /etc/systemd/system/veduta.service.d/access.conf || return 1
  else
    rm -f /etc/systemd/system/veduta.service.d/access.conf || return 1
  fi
  systemctl daemon-reload
}

access_abort() {
  if [ "$ACCESS_TRANSACTION" != true ] || [ "$ACCESS_COMMITTED" = true ]; then return 0; fi
  if ! access_restore_configuration; then
    printf 'error: could not restore the previous access configuration. Candidate files retained. Inspect: sudo journalctl -u veduta -u veduta-access-test -n 50; then run sudo veduta access\n' >&2
    return 1
  fi
  systemctl stop veduta-access-test || true
  if ! systemctl restart veduta; then
    printf 'error: previous access configuration restored, but Veduta could not restart. Run: sudo systemctl restart veduta && sudo journalctl -u veduta -n 50\n' >&2
    return 1
  fi
  local previous_domain="${CURRENT_ORIGIN#https://}"
  if ! ACCESS="$CURRENT_ACCESS" ACCESS_PORT="$CURRENT_PORT" ORIGIN="$CURRENT_ORIGIN" \
    DOMAIN="${previous_domain%%:*}" SERVICE_NAME=veduta wait_for_gateway; then
    printf 'error: previous configuration restored but the Gateway is not ready. Recovery files retained; run sudo veduta setup.\n' >&2
    return 1
  fi
  rm -f /run/systemd/system/veduta-access-test.service
  systemctl daemon-reload
  ACCESS_TRANSACTION=false
  rm -f "/var/lib/veduta/access-auth/${ACCESS_GENERATION##*/}.json"
  rm -rf "$ACCESS_GENERATION"
  printf 'Restored the previous access: %s\n' "$CURRENT_ORIGIN" >&2
}
