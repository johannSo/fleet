export LC_ALL=C
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
. /etc/os-release 2>/dev/null
echo "hostname=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname)"
echo "os=$PRETTY_NAME"
echo "os_id=$ID"
echo "os_like=$ID_LIKE"
if command -v omarchy-version >/dev/null 2>&1; then echo "omarchy=$(omarchy-version 2>/dev/null | head -1)"; elif [ -d "$HOME/.local/share/omarchy" ]; then echo "omarchy=?"; fi
echo "kernel=$(uname -r)"
echo "arch=$(uname -m)"
d=/sys/devices/virtual/dmi/id
for f in sys_vendor product_name product_version board_vendor board_name chassis_type; do
  [ -r "$d/$f" ] && echo "dmi_$f=$(tr -d '\n' < "$d/$f" 2>/dev/null)"
done
[ -r /proc/device-tree/model ] && echo "dt_model=$(tr -d '\0' < /proc/device-tree/model)"
echo "virt=$(systemd-detect-virt 2>/dev/null)"
for p in Hyprland plasmashell gnome-shell sway niri cosmic-comp xfce4-session cinnamon mate-session lxqt-session; do
  pgrep -x "$p" >/dev/null 2>&1 && { echo "desktop=$p"; break; }
done
lscpu 2>/dev/null | sed -n 's/^\(Model name\|CPU(s)\|Thread(s) per core\|CPU max MHz\):[[:space:]]*/cpu_\1=/p'
awk '/^(MemTotal|SwapTotal):/ {gsub(":","",$1); print "mem_" $1 "=" $2*1024}' /proc/meminfo
lsmem -b --summary=only 2>/dev/null | sed -n 's/^Total online memory:[[:space:]]*/mem_online=/p'
lspci -vmm 2>/dev/null | awk 'BEGIN{RS="";FS="\n"} /Class:[ \t]*(VGA|3D|Display)/ { for (i=1;i<=NF;i++) print "pci=" $i; print "pci=--" }'
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | sed 's/^/nvidia=/'
lsblk -d -b -n -P -o NAME,SIZE,TYPE,TRAN,ROTA,RM,VENDOR,MODEL 2>/dev/null | sed 's/^/disk=/'
for b in /sys/block/mmcblk*; do [ -r "$b/device/type" ] && echo "mmc=$(basename "$b")|$(cat "$b/device/type")"; done
for n in /sys/class/net/*; do
  i=$(basename "$n")
  [ "$i" = lo ] && continue
  echo "nic=$i|$(cat "$n/address" 2>/dev/null)|$(cat "$n/operstate" 2>/dev/null)|$(cat "$n/speed" 2>/dev/null)|$([ -e "$n/device" ] && echo 1 || echo 0)|$([ -d "$n/wireless" ] || [ -e "$n/phy80211" ] && echo 1 || echo 0)|$(cat "$n/type" 2>/dev/null)|$(sed -n 's/^DEVTYPE=//p' "$n/uevent" 2>/dev/null)"
done
ip -o addr show scope global 2>/dev/null | awk '{ f=""; for (i=5;i<=NF;i++) if ($i=="temporary"||$i=="deprecated") f="tmp"; print "ip=" $2 "|" $3 "|" $4 "|" f }'
ip route show default 2>/dev/null | awk '{ for (i=1;i<NF;i++) if ($i=="dev") print "route=" $(i+1) }'
ip route show default 2>/dev/null | awk '{ v=""; d=""; for (i=1;i<NF;i++) { if ($i=="via") v=$(i+1); if ($i=="dev") d=$(i+1) } if (v && d) print d, v }' | while read -r d v; do
  echo "gw=$d|$v|$(ip neigh show "$v" dev "$d" 2>/dev/null | awk '{ for (i=1;i<NF;i++) if ($i=="lladdr") { print $(i+1); exit } }')"
done
for b in /sys/class/power_supply/BAT*; do
  [ -d "$b" ] || continue
  full=$(cat "$b/energy_full" 2>/dev/null || cat "$b/charge_full" 2>/dev/null)
  design=$(cat "$b/energy_full_design" 2>/dev/null || cat "$b/charge_full_design" 2>/dev/null)
  echo "battery=$full|$design"
done
if ! command -v docker >/dev/null 2>&1; then echo "docker=none"
elif docker ps >/dev/null 2>&1; then echo "docker=ok"; D="docker"
elif sudo -n docker ps >/dev/null 2>&1; then echo "docker=sudo"; D="sudo -n docker"
else echo "docker=denied"; fi
[ -n "$D" ] && $D ps -a --format 'ctr={{.Names}}	{{.Image}}	{{.State}}	{{.Ports}}' 2>/dev/null
(sudo -n ss -Hltnup 2>/dev/null || ss -Hltnup 2>/dev/null) | awk '{ p=""; if (match($0, /users:\(\("[^"]+"/)) p=substr($0, RSTART+9, RLENGTH-10); print "port=" $1 "|" $5 "|" p }'
systemctl --user list-units --type=service --state=running --no-legend --plain --no-pager 2>/dev/null | awk '{print "usvc=" $1}'
if command -v omarchy-update >/dev/null 2>&1; then echo pkg=omarchy
elif command -v yay >/dev/null 2>&1; then echo pkg=yay
elif command -v paru >/dev/null 2>&1; then echo pkg=paru
elif command -v pacman >/dev/null 2>&1; then echo pkg=pacman
elif command -v apt-get >/dev/null 2>&1; then echo pkg=apt
elif command -v dnf >/dev/null 2>&1; then echo pkg=dnf
else echo pkg=unknown; fi
echo "end=1"
