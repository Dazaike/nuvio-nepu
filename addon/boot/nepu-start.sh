#!/system/bin/sh
# Started by init (nepu.rc) as uid 10066. Termux's node needs Termux's environment; nothing else is touched.
T=/data/data/com.termux/files
export HOME=$T/home PREFIX=$T/usr PATH=$T/usr/bin:/system/bin TMPDIR=$T/usr/tmp LD_LIBRARY_PATH=$T/usr/lib LANG=en_US.UTF-8
cd "$HOME/nuvio-nepu" || { log -t nepu "no $HOME/nuvio-nepu"; exit 1; }
log -t nepu "starting addon"
exec "$PREFIX/bin/node" addon/server.js >> "$HOME/nepu-addon.log" 2>&1
