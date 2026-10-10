#!/usr/bin/env python3
"""Deterministic external CLI boundary for the private installer tests."""
import json
import fcntl
import os
import signal
import sys
import time
from pathlib import Path

path = Path(os.environ['VEDUTA_TEST_TAILNET_STATE'])
lock = open(str(path) + '.lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX)
state = json.loads(path.read_text())
args = sys.argv[1:]
command = Path(sys.argv[0]).name
state.setdefault('calls', []).append([command, *args])

def save():
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state))
    temporary.replace(path)

save()
if command == 'curl':
    if state.get('httpsPending', 0) > 0:
        state['httpsPending'] -= 1
        save()
        sys.exit(28)
    if state.get('certificateFailure'):
        sys.exit(60)
    print(json.dumps({'mode': 'production', 'passkeyRegistered': True}))
elif command == 'systemctl':
    if args[:2] == ['stop', 'veduta-serve-candidate'] and state.get('servePid'):
        try:
            os.kill(state['servePid'], signal.SIGTERM)
        except ProcessLookupError:
            pass
elif command == 'systemd-run':
    start = args.index('tailscale')
    os.execvp('tailscale', args[start:])
elif args[:1] == ['status']:
    print(json.dumps(state['status']))
elif args[:1] == ['up']:
    state['status'] = state['loginStatus']
    save()
    print('Authenticate at https://login.tailscale.com/a/test-only')
elif args[:2] == ['serve', 'status']:
    if state.get('serveReadFailure'):
        sys.exit(1)
    print(json.dumps(state.get('serve')))
elif args[:1] == ['serve']:
    if 'reset' in args or 'funnel' in args:
        sys.exit(99)
    port = next(arg.split('=', 1)[1] for arg in args if arg.startswith('--https='))
    host = state['status']['Self']['DNSName'].rstrip('.')
    endpoint = host + ':' + port
    serve = state.setdefault('serve', {})
    persistent = '--bg' in args
    config = serve if persistent else serve.setdefault('Foreground', {}).setdefault('test-session', {})
    if args[-1] == 'off':
        handlers = config.get('Web', {}).get(endpoint, {}).get('Handlers', {})
        handlers.pop('/', None)
        if not handlers:
            config.get('Web', {}).pop(endpoint, None)
            config.get('TCP', {}).pop(port, None)
            config.get('AllowFunnel', {}).pop(endpoint, None)
    else:
        config.setdefault('TCP', {})[port] = {'HTTPS': True}
        config.setdefault('Web', {}).setdefault(endpoint, {}).setdefault('Handlers', {})['/'] = {'Proxy': args[-1]}
        if not persistent:
            state['servePid'] = os.getpid()
    save()
    if not persistent and args[-1] != 'off':
        fcntl.flock(lock, fcntl.LOCK_UN)
        def stop(_signal, _frame):
            global state
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = json.loads(path.read_text())
            state.get('serve', {}).get('Foreground', {}).pop('test-session', None)
            state.pop('servePid', None)
            save()
            sys.exit(0)
        signal.signal(signal.SIGTERM, stop)
        while True:
            time.sleep(.1)
else:
    print('Unexpected fake CLI call: ' + repr(args), file=sys.stderr)
    sys.exit(2)
