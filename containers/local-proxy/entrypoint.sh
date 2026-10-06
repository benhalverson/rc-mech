#!/bin/sh
set -eu

# WSL marks ingress packets through socket/DIVERT, preventing HTTP readiness.
# Exempt only this proxy's local ingress listener; retain outbound interception.
ingress_port=
previous=
for argument in "$@"; do
	if [ "$previous" = --http-ingress-address ]; then
		ingress_port=${argument##*:}
	fi
	previous=$argument
done
case "$ingress_port" in
	''|*[!0-9]*) exec /proxy-everything "$@" ;;
esac

/proxy-everything "$@" &
proxy_pid=$!
trap 'kill "$proxy_pid" 2>/dev/null || true; wait "$proxy_pid" 2>/dev/null || true; exit 143' TERM INT

attempt=0
while ! iptables -t mangle -C PREROUTING -p tcp -m socket -j DIVERT 2>/dev/null; do
	if ! kill -0 "$proxy_pid" 2>/dev/null; then
		wait "$proxy_pid"
		exit 1
	fi
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 600 ]; then
		echo 'Local proxy interception rules did not become ready.' >&2
		kill "$proxy_pid" 2>/dev/null || true
		wait "$proxy_pid" 2>/dev/null || true
		exit 1
	fi
	sleep 0.05
done

if ! iptables -t mangle -I PREROUTING 1 -p tcp --dport "$ingress_port" -m addrtype --dst-type LOCAL -j ACCEPT; then
	 kill "$proxy_pid" 2>/dev/null || true
	 wait "$proxy_pid" 2>/dev/null || true
	 exit 1
fi
wait "$proxy_pid"
