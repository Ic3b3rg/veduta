#!/usr/bin/env bash
# Tailscale CLI boundary for issue #49. Only Veduta's / handler is changed.
# CLI contract: https://tailscale.com/docs/reference/tailscale-cli/serve
# Candidate routes run in the foreground: tailscaled removes them on disconnect
# or reboot. Only a verified passkey promotes a candidate to persistent Serve.

TAILNET_HOST=""
TAILNET_ID=""
TAILNET_SERVE_PID=""
TAILNET_ROUTE_CREATED=false
TAILNET_ROUTE_PERSISTENT=false
TAILNET_PREVIOUS_REMOVED=false

private_access_error() {
  printf 'error: %s\nRecover over SSH with: sudo veduta access\n' "$1" >&2
  return 1
}

tailnet_connected_host() {
  local status
  status=$(tailscale status --json --peers=false) || { private_access_error 'Tailscale is unavailable.'; return 1; }
  if ! printf '%s' "$status" | jq -e '.BackendState == "Running" and .Self.Online == true' >/dev/null; then
    private_access_error "Tailscale is $(printf '%s' "$status" | jq -r '.BackendState'). Connect and approve the VPS in Tailscale."
    return 1
  fi
  TAILNET_HOST=$(printf '%s' "$status" | jq -er '.Self.DNSName | rtrimstr(".")') || return 1
  if ! [[ "$TAILNET_HOST" =~ ^[a-z0-9][a-z0-9-]*\.[a-z0-9-]+\.ts\.net$ ]]; then
    private_access_error 'Tailscale has no usable *.ts.net name. Enable MagicDNS in your Tailscale DNS settings.'
    return 1
  fi
  TAILNET_ID=$(printf '%s' "$status" | jq -er '.CurrentTailnet.StableID // .CurrentTailnet.Name') || return 1
}

tailnet_endpoint_state() {
  local config occupied
  config=$(tailscale serve status --json) || { private_access_error 'Cannot read Serve configuration; no routes were changed.'; return 1; }
  occupied=$(printf '%s' "$config" | jq -r --arg port "$1" '
    if . == null then {} elif type == "object" then . else error("invalid Serve status") end |
    [., (.Foreground // {} | .[])] | any(.[];
      .TCP[$port] != null or
      ((.Web // {} | keys) | any(endswith(":" + $port))) or
      ((.AllowFunnel // {} | keys) | any(endswith(":" + $port))))') || return 1
  if [ "$occupied" = true ]; then printf busy; else printf free; fi
}

tailnet_route_matches() {
  local host="$1" port="$2" backend="$3"
  tailscale serve status --json | jq -e --arg endpoint "$host:$port" --arg port "$port" \
    --arg proxy "http://127.0.0.1:$backend" '
    [., (.Foreground // {} | .[])] |
      any(.[]; .TCP[$port].HTTPS == true and .Web[$endpoint].Handlers["/"] == {Proxy:$proxy}) and
      (any(.[]; .AllowFunnel[$endpoint] == true) | not)' >/dev/null
}

tailnet_assert_backend_private() {
  local config exposed
  config=$(tailscale serve status --json) || return 1
  exposed=$(printf '%s' "$config" | node "${BASH_SOURCE[0]%/*}/tailnet-backend-private.mjs" "$ACCESS_PORT") || {
    private_access_error 'Cannot inspect existing Funnel backends; no access change was committed.'; return 1;
  }
  if [ "$exposed" = true ]; then
    private_access_error 'An existing Funnel route targets this loopback port. Choose another --port or remove that exposure yourself; no existing routes were changed.'
    return 1
  fi
}

tailnet_assert_hostname() {
  local current
  current=$(tailscale status --json --peers=false | jq -er '.Self.DNSName | rtrimstr(".")') || return 1
  if [ "$current" != "$1" ]; then
    private_access_error "The hostname changed; refusing to modify a route for $1 through $current. Restore the previous machine name in https://login.tailscale.com/admin/machines and choose Repair, or remove the stale route before Update access."
    return 1
  fi
}

tailnet_ensure_installed() {
  if command -v tailscale >/dev/null 2>&1; then return 0; fi
  if [ "$TAILSCALE_INSTALL_CONSENT" != true ]; then
    private_access_error 'Tailscale installation needs consent. Rerun the guided installer and choose Tailnet access.'
    return 1
  fi
  local script
  script=$(mktemp /tmp/veduta-tailscale.XXXXXX)
  if ! curl -fsSL https://tailscale.com/install.sh -o "$script" || ! run sh "$script"; then
    rm -f "$script"
    private_access_error 'Tailscale installation failed. Check the installation log and rerun setup.'
    return 1
  fi
  rm -f "$script"
}

tailnet_prepare() {
  tailnet_ensure_installed || return 1
  run systemctl enable --now tailscaled || return 1
  local status approved=false free_port endpoint
  status=$(tailscale status --json --peers=false) || status='{}'
  if ! printf '%s' "$status" | jq -e '.BackendState == "Running" and .Self.Online == true' >/dev/null; then
    if [ "$EXPLICIT_APPLY" = true ]; then
      private_access_error 'Unattended Tailnet setup needs an already connected node. Run sudo tailscale up, approve the VPS, then retry.'
      return 1
    fi
    printf '\nOpen the Tailscale login link below using your personal account.\nIf approval is required, approve this VPS at https://login.tailscale.com/admin/machines\n' >&2
    INSTALLER_STATE=waiting-input; emit_event true
    tailscale up --timeout=15m >&2 || return 1
  fi
  tailnet_connected_host || return 1
  if [ -f "$ACCESS_CONFIG" ]; then
    approved=$(jq -r --arg id "$TAILNET_ID" '(.tailnetId == $id) and (.deviceApprovalConfirmed == true)' "$ACCESS_CONFIG")
  fi
  if [ "$approved" != true ] && [ "$TAILNET_DEVICE_APPROVAL" != true ]; then
    printf '\nFor access only from your approved devices, enable Device approval:\n  https://login.tailscale.com/admin/settings/device-management\nUse a personal tailnet containing only the people/devices you intend to allow.\nThis setting is account-wide; Veduta cannot verify it through the local CLI.\n' >&2
    if [ "$EXPLICIT_APPLY" = true ]; then
      private_access_error 'Confirm the account setting with --device-approval-confirmed, or use guided setup.'
      return 1
    fi
    prompt_tty 'Have you enabled device approval in this account?' N
    case "$REPLY" in y|Y|yes|YES) ;; *) private_access_error 'Enable device approval, then rerun the installer using its retry command.'; return 1 ;; esac
  fi
  TAILNET_DEVICE_APPROVAL=true
  if [ "$CURRENT_ACCESS" = tailnet ] && [ "$EDIT_ACCESS" != true ] && [ "$EXPLICIT_APPLY" != true ]; then
    case "$CURRENT_ORIGIN" in "https://$TAILNET_HOST"|"https://$TAILNET_HOST:"*) ;; *)
      private_access_error 'The Tailscale hostname changed. Choose Update access to verify a new address and passkey.'; return 1 ;; esac
  fi
  TAILNET_HTTPS_PORT=${TAILNET_HTTPS_PORT:-443}
  endpoint=$(tailnet_endpoint_state "$TAILNET_HTTPS_PORT") || return 1
  if [ "$endpoint" = busy ]; then
    if [ "$CURRENT_ACCESS" = tailnet ] &&
      { [ "$CURRENT_ORIGIN" = "https://$TAILNET_HOST" ] || [ "$CURRENT_ORIGIN" = "https://$TAILNET_HOST:$TAILNET_HTTPS_PORT" ]; } &&
      [ "$TAILNET_HTTPS_PORT" = "$CURRENT_TAILNET_PORT" ] &&
      tailnet_route_matches "$TAILNET_HOST" "$TAILNET_HTTPS_PORT" "$CURRENT_PORT"; then
      :
    else
      free_port=8443
      while [ "$free_port" -le 65535 ]; do
        endpoint=$(tailnet_endpoint_state "$free_port") || return 1
        if [ "$endpoint" = free ]; then break; fi
        free_port=$((free_port + 1))
      done
      if [ "$free_port" -gt 65535 ]; then private_access_error 'No free Serve HTTPS port.'; return 1; fi
      printf 'Tailscale HTTPS port %s belongs to an existing Serve/Funnel configuration.\n' "$TAILNET_HTTPS_PORT" >&2
      if [ "$EXPLICIT_APPLY" = true ]; then
        private_access_error "Choose a free endpoint with --tailnet-port $free_port; existing routes were left untouched."; return 1
      fi
      prompt_tty 'Private HTTPS port' "$free_port"; TAILNET_HTTPS_PORT="$REPLY"
      validate_access_args
      endpoint=$(tailnet_endpoint_state "$TAILNET_HTTPS_PORT") || return 1
      if [ "$endpoint" = busy ]; then private_access_error 'The selected Tailscale port is occupied.'; return 1; fi
    fi
  fi
  ORIGIN="https://$TAILNET_HOST"
  if [ "$TAILNET_HTTPS_PORT" != 443 ]; then ORIGIN="$ORIGIN:$TAILNET_HTTPS_PORT"; fi
  if [ "$EXISTING_ACCESS" = true ] && [ "$ORIGIN" = "$CURRENT_ORIGIN" ] && [ "$ACCESS_PORT" != "$CURRENT_PORT" ]; then
    private_access_error 'Changing the loopback port requires a free --tailnet-port too, so the old route can be retained until verification.'; return 1
  fi
  if [ "$EXISTING_ACCESS" = true ] && [ "$ORIGIN" != "$CURRENT_ORIGIN" ]; then ACCESS_CHANGE=true; fi
  tailnet_assert_backend_private || return 1
  printf 'Private address: %s\n' "$ORIGIN" >&2
}

tailnet_stage_route() {
  if [ "$ACCESS" != tailnet ]; then return 0; fi
  tailnet_assert_backend_private || return 1
  if [ "$CURRENT_ACCESS" = tailnet ] && [ "$ORIGIN" = "$CURRENT_ORIGIN" ] &&
     tailnet_route_matches "$TAILNET_HOST" "$TAILNET_HTTPS_PORT" "$ACCESS_PORT"; then return 0; fi
  # Recheck immediately before mutation; never take over an unowned endpoint.
  local endpoint
  endpoint=$(tailnet_endpoint_state "$TAILNET_HTTPS_PORT") || return 1
  if [ "$endpoint" = busy ]; then private_access_error 'Serve changed during setup. No route was overwritten.'; return 1; fi
  tailnet_assert_hostname "$TAILNET_HOST" || return 1
  TAILNET_ROUTE_CREATED=true
  if [ "$ACCESS_CHANGE" = true ]; then
    systemd-run --unit=veduta-serve-candidate --collect --pipe \
      --property=RuntimeMaxSec=900 --property=PartOf=veduta-access-test.service \
      tailscale serve --https="$TAILNET_HTTPS_PORT" --set-path=/ "http://127.0.0.1:$ACCESS_PORT" >&2 &
    TAILNET_SERVE_PID=$!
  else
    tailscale serve --bg --https="$TAILNET_HTTPS_PORT" --set-path=/ "http://127.0.0.1:$ACCESS_PORT" >&2 || return 1
    TAILNET_ROUTE_PERSISTENT=true
  fi
  local waited=0
  while [ "$waited" -lt 900 ]; do
    if tailnet_route_matches "$TAILNET_HOST" "$TAILNET_HTTPS_PORT" "$ACCESS_PORT"; then return 0; fi
    if [ -n "$TAILNET_SERVE_PID" ] && ! kill -0 "$TAILNET_SERVE_PID" 2>/dev/null; then
      private_access_error 'Tailscale Serve stopped before configuring HTTPS.'; return 1
    fi
    sleep 2; waited=$((waited + 2))
  done
  private_access_error 'Timed out waiting for Tailscale HTTPS consent. Open the link printed by Tailscale and retry.'
}

tailnet_verify() {
  local expected="$TAILNET_HOST" status
  tailnet_connected_host || return 1
  if [ "$TAILNET_HOST" != "$expected" ]; then private_access_error 'The Tailscale hostname changed during setup.'; return 1; fi
  status=$(tailscale status --json --peers=false) || return 1
  if ! printf '%s' "$status" | jq -e --arg host "$TAILNET_HOST" \
    '.CurrentTailnet.MagicDNSEnabled == true and ((.CertDomains // []) | index($host) != null)' >/dev/null; then
    private_access_error 'Enable MagicDNS and HTTPS in the Tailscale DNS settings, then repair access.'; return 1
  fi
  if ! tailnet_route_matches "$TAILNET_HOST" "$TAILNET_HTTPS_PORT" "$ACCESS_PORT"; then
    private_access_error 'Veduta must have its own private HTTPS Serve route, without Funnel.'; return 1
  fi
  tailnet_assert_backend_private || return 1
  # Certificate chain, hostname, DNS, Serve proxy and real production Gateway in one request.
  if ! curl -fsS --connect-timeout 5 --max-time 20 "$ORIGIN/api/auth/status" | jq -e '.mode == "production"' >/dev/null; then
    private_access_error 'Private HTTPS could not reach the Gateway with a valid certificate. Check Tailscale DNS/HTTPS and retry.'; return 1
  fi
}

tailnet_stop_candidate() {
  if [ -n "$TAILNET_SERVE_PID" ]; then
    if ! systemctl stop veduta-serve-candidate 2>/dev/null && systemctl is-active --quiet veduta-serve-candidate; then
      private_access_error 'Could not stop the staged Serve route.'; return 1
    fi
    wait "$TAILNET_SERVE_PID" 2>/dev/null || true
    TAILNET_SERVE_PID=""
  fi
}

tailnet_remove_route() {
  local host="$1" port="$2" backend="$3"
  local config
  TAILNET_ROUTE_REMOVED=false
  config=$(tailscale serve status --json) || return 1
  if printf '%s' "$config" | jq -e --arg endpoint "$host:$port" '.Web[$endpoint].Handlers["/"] == null' >/dev/null; then return 0; fi
  if ! printf '%s' "$config" | jq -e --arg endpoint "$host:$port" --arg port "$port" \
    --arg proxy "http://127.0.0.1:$backend" \
    '.TCP[$port].HTTPS == true and .Web[$endpoint].Handlers["/"] == {Proxy:$proxy}' >/dev/null; then
    private_access_error 'The owned Serve route changed externally; refusing to delete another service.'; return 1
  fi
  tailnet_assert_hostname "$host" || return 1
  tailscale serve --bg --https="$port" --set-path=/ off >&2 || return 1
  TAILNET_ROUTE_REMOVED=true
}

tailnet_persist_candidate() {
  if [ "$ACCESS" = tailnet ]; then
    if [ "$TAILNET_ROUTE_CREATED" = true ] && [ "$TAILNET_ROUTE_PERSISTENT" != true ]; then
      tailnet_stop_candidate || return 1
      local endpoint waited=0
      while [ "$waited" -lt 10 ]; do
        endpoint=$(tailnet_endpoint_state "$TAILNET_HTTPS_PORT") || return 1
        if [ "$endpoint" = free ]; then break; fi
        sleep 1; waited=$((waited + 1))
      done
      if [ "$endpoint" = busy ]; then private_access_error 'Serve changed during activation.'; return 1; fi
      tailnet_assert_hostname "$TAILNET_HOST" || return 1
      TAILNET_ROUTE_PERSISTENT=true
      tailscale serve --bg --https="$TAILNET_HTTPS_PORT" --set-path=/ "http://127.0.0.1:$ACCESS_PORT" >&2 || return 1
    fi
    tailnet_verify || return 1
  fi
}

tailnet_commit() {
  tailnet_persist_candidate || return 1
  if [ "$CURRENT_ACCESS" = tailnet ] && [ "$CURRENT_ORIGIN" != "$ORIGIN" ]; then
    local old_host="${CURRENT_ORIGIN#https://}"
    tailnet_remove_route "${old_host%%:*}" "$CURRENT_TAILNET_PORT" "$CURRENT_PORT" || return 1
    TAILNET_PREVIOUS_REMOVED=$TAILNET_ROUTE_REMOVED
  fi
}

tailnet_abort() {
  tailnet_stop_candidate || return 1
  if [ "$TAILNET_ROUTE_CREATED" = true ] && [ "$TAILNET_ROUTE_PERSISTENT" = true ] && [ "$ACCESS_CHANGE" = true ]; then
    tailnet_remove_route "$TAILNET_HOST" "$TAILNET_HTTPS_PORT" "$ACCESS_PORT" || return 1
  fi
  if [ "$TAILNET_PREVIOUS_REMOVED" = true ]; then
    local config old_host="${CURRENT_ORIGIN#https://}"
    old_host="${old_host%%:*}"
    tailnet_assert_hostname "$old_host" || return 1
    config=$(tailscale serve status --json) || return 1
    # A sibling handler can remain. Only the owned / slot must still be empty.
    if ! printf '%s' "$config" | jq -e --arg port "$CURRENT_TAILNET_PORT" --arg endpoint "$old_host:$CURRENT_TAILNET_PORT" '
      (.TCP[$port] == null or .TCP[$port] == {HTTPS:true}) and
      .Web[$endpoint].Handlers["/"] == null and .AllowFunnel[$endpoint] != true and
      ([.Foreground // {} | .[]] | all(.[]; .TCP[$port] == null))' >/dev/null; then
      private_access_error 'Cannot restore the old Serve root handler: its slot changed externally.'; return 1
    fi
    tailscale serve --bg --https="$CURRENT_TAILNET_PORT" --set-path=/ "http://127.0.0.1:$CURRENT_PORT" >&2 || return 1
  fi
}
