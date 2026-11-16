export LC_ALL=C
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
echo "##procs"
ps -eo pid=,user=,pcpu=,pmem=,rss=,args= --sort=-pcpu 2>/dev/null | head -200
echo "##units"
systemctl list-units --type=service --state=running,failed --no-legend --plain --no-pager 2>/dev/null | sed 's/^/system /'
systemctl --user list-units --type=service --state=running,failed --no-legend --plain --no-pager 2>/dev/null | sed 's/^/user /'
echo "##docker"
if ! command -v docker >/dev/null 2>&1; then echo "access=none"
elif docker ps >/dev/null 2>&1; then echo "access=ok"; D="docker"
elif sudo -n docker ps >/dev/null 2>&1; then echo "access=sudo"; D="sudo -n docker"
else echo "access=denied"; fi
if [ -n "$D" ]; then $D ps -a --format '{{.ID}}	{{.Names}}	{{.Image}}	{{.State}}	{{.Status}}	{{.Ports}}' 2>/dev/null; fi
echo "##listen"
(sudo -n ss -Hltnup 2>/dev/null || ss -Hltnup 2>/dev/null)
echo "##end"
