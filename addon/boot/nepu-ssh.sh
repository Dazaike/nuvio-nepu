#!/system/bin/sh
# Started by init (nepu.rc) as uid 10066. -D keeps sshd in the foreground so init can supervise and restart it.
T=/data/data/com.termux/files
export HOME=$T/home PREFIX=$T/usr PATH=$T/usr/bin:/system/bin TMPDIR=$T/usr/tmp LD_LIBRARY_PATH=$T/usr/lib
exec "$PREFIX/bin/sshd" -D -e
