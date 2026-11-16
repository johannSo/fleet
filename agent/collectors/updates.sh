export LC_ALL=C
if command -v checkupdates >/dev/null 2>&1; then
  checkupdates 2>/dev/null | awk '{print "pkg=" $1 "|" $2 "|" $4}'
  if command -v yay >/dev/null 2>&1; then yay -Qua 2>/dev/null | awk '{print "pkg=" $1 "|" $2 "|" $4 "|aur"}'; fi
elif command -v apt >/dev/null 2>&1; then
  apt list --upgradable 2>/dev/null | awk -F'[/ ]' 'NR>1 && NF>3 { from=$0; sub(/.*from: /, "", from); sub(/\]$/, "", from); print "pkg=" $1 "|" from "|" $3 }'
elif command -v dnf >/dev/null 2>&1; then
  dnf -q check-update 2>/dev/null | awk 'NF==3 {print "pkg=" $1 "|?|" $2}'
fi
echo done=1
