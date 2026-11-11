#!/system/bin/sh
# Starts the Nepu addon (and Termux's sshd) at boot and keeps them running. Run as root from your boot hook (KernelSU service.sh, tvfix, ...).
# The addon itself runs as the Termux user, NOT root: it listens on the LAN.
#
#   Termux uid:   adb shell dumpsys package com.termux | grep userId      (10066 on this box = u0_a66)
#   Test by hand: sh /data/local/tmp/nepu-boot.sh        log: /data/local/tmp/nepu-boot.log
#
# Crash/restart behaviour: the loop below restarts node 3 s after it exits, for any reason.

UID_TERMUX=10066
T=/data/data/com.termux/files
LOG=/data/local/tmp/nepu-boot.log

# Already supervising? (a second copy would fight over port 7861)
if [ -f /data/local/tmp/nepu-boot.pid ] && kill -0 "$(cat /data/local/tmp/nepu-boot.pid)" 2>/dev/null; then
  echo "$(date '+%F %T') already running as $(cat /data/local/tmp/nepu-boot.pid)" >> $LOG
  exit 0
fi
echo $$ > /data/local/tmp/nepu-boot.pid

# as_termux '<shell command>': run a command with Termux's environment as the Termux user
as_termux() {
  su $UID_TERMUX -c "env HOME=$T/home PREFIX=$T/usr PATH=$T/usr/bin:/system/bin TMPDIR=$T/usr/tmp LD_LIBRARY_PATH=$T/usr/lib LANG=en_US.UTF-8 sh -c '$1'"
}

until [ "$(getprop sys.boot_completed)" = 1 ]; do sleep 2; done
# Wi-Fi comes up late (your sleepfix/tvfix scripts also touch it); the addon only needs it at request time, but wait for an address anyway.
n=0; while [ $n -lt 60 ]; do ip -4 addr show wlan0 2>/dev/null | grep -q 'inet ' && break; sleep 2; n=$((n+1)); done

echo "$(date '+%F %T') boot start (wlan0 wait=$n)" >> $LOG
as_termux "sshd" >> $LOG 2>&1          # Termux sshd, port 8022 (harmless if already running)

while true; do
  echo "$(date '+%F %T') starting node" >> $LOG
  as_termux 'cd $HOME/nuvio-nepu && exec node addon/server.js >> $HOME/nepu-addon.log 2>&1'
  echo "$(date '+%F %T') node exited (code $?), restarting in 3 s" >> $LOG
  sleep 3
done
