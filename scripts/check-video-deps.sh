#!/usr/bin/env bash
# Check a host for everything goon.vc /clips needs to process video:
# ffmpeg + ffprobe (libx264, aac, mov_text, mjpeg, and the filters the proxy,
# thumbnail sprite, and render commands use), optional yt-dlp for link
# imports, disk space for the clips Store, and access to Discord's CDN.
# Each ffmpeg command services/clips.js and functions/clipRenderPlan.js run is
# also run for real on a short generated clip.
#
#   bash scripts/check-video-deps.sh             (from the goon.vc checkout)
#   bash scripts/check-video-deps.sh --links     (yt-dlp is required, as with GOON_CLIPS_LINKS=1)
#   bash scripts/check-video-deps.sh --offline   (skip the network checks)
#
# Overrides: FFMPEG, FFPROBE, YTDLP (binary paths), GOON_CLIPS_STORE (default stores/clips).
# Exits 1 when something /clips needs is missing; warnings alone exit 0.

set -u

FFMPEG="${FFMPEG:-ffmpeg}"
FFPROBE="${FFPROBE:-ffprobe}"
YTDLP="${YTDLP:-yt-dlp}"
STORE="${GOON_CLIPS_STORE:-stores/clips}"
LINKS=0
[ "${GOON_CLIPS_LINKS:-}" = "1" ] && LINKS=1
NETWORK=1
for arg in "$@"; do
  case "$arg" in
    --links) LINKS=1 ;;
    --offline) NETWORK=0 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

FAILS=0
WARNS=0
if [ -t 1 ]; then G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'; else G=; Y=; R=; B=; N=; fi
pass () { printf '  %sok%s    %s\n' "$G" "$N" "$*"; }
warn () { printf '  %swarn%s  %s\n' "$Y" "$N" "$*"; WARNS=$((WARNS + 1)); }
fail () { printf '  %sFAIL%s  %s\n' "$R" "$N" "$*"; FAILS=$((FAILS + 1)); }
section () { printf '\n%s%s%s\n' "$B" "$*" "$N"; }
have () { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
hint () {
  # $1 = what to install
  case "$1" in
    ffmpeg)
      if have apt-get; then echo "sudo apt-get install -y ffmpeg"
      elif have dnf; then echo "sudo dnf install -y ffmpeg (RPM Fusion), or a static build from https://johnvansickle.com/ffmpeg/"
      elif have brew; then echo "brew install ffmpeg"
      else echo "a full ffmpeg build (with libx264) from https://ffmpeg.org/download.html"; fi ;;
    yt-dlp)
      echo "a current release (distro packages go stale): sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp" ;;
  esac
}

printf '%sgoon.vc video dependency check%s (%s, %s)\n' "$B" "$N" "$(hostname 2>/dev/null || echo host)" "$OS"

# --- ffmpeg / ffprobe ------------------------------------------------------
section "ffmpeg / ffprobe (required)"
FFMPEG_OK=1
for bin in "$FFMPEG" "$FFPROBE"; do
  if have "$bin"; then
    pass "$bin: $(command -v "$bin") — $("$bin" -hide_banner -version 2>/dev/null | head -n1 | cut -d' ' -f1-3)"
  else
    fail "$bin not found. Install: $(hint ffmpeg)"
    FFMPEG_OK=0
  fi
done

if [ "$FFMPEG_OK" = 1 ]; then
  ENCODERS="$("$FFMPEG" -hide_banner -encoders 2>/dev/null)"
  DECODERS="$("$FFMPEG" -hide_banner -decoders 2>/dev/null)"
  FILTERS="$("$FFMPEG" -hide_banner -filters 2>/dev/null)"
  FORMATS="$("$FFMPEG" -hide_banner -formats 2>/dev/null)"

  for enc in libx264 aac mov_text mjpeg; do
    if printf '%s\n' "$ENCODERS" | grep -Eq "^ [A-Z.]{6} $enc( |$)"; then pass "encoder $enc"
    else
      case "$enc" in
        libx264) fail "encoder libx264 missing (proxies and renders are H.264). This ffmpeg was built without --enable-libx264; install: $(hint ffmpeg)" ;;
        *) fail "encoder $enc missing. Install: $(hint ffmpeg)" ;;
      esac
    fi
  done

  for f in scale fps tile pad setsar format trim setpts asetpts aresample aformat apad atrim anullsrc concat volume; do
    if printf '%s\n' "$FILTERS" | grep -Eq "^ [A-Z.]{2,3} +$f +"; then :; else fail "filter $f missing"; MISSING_FILTER=1; fi
  done
  [ -z "${MISSING_FILTER:-}" ] && pass "filters: scale fps tile pad setsar format trim setpts asetpts aresample aformat apad atrim anullsrc concat volume"

  # Inputs pilots post: ShadowPlay/OBS/Medal (H.264/HEVC in mp4/mov/mkv), Discord re-encodes, web clips (VP9/AV1 in webm).
  DECODED=
  for dec in 'h264' 'hevc' 'vp9|libvpx-vp9' 'av1|libdav1d|libaom-av1' 'aac' 'opus|libopus'; do
    name="${dec%%|*}"
    if printf '%s\n' "$DECODERS" | grep -Eq "^ [A-Z.]{6} ($dec) "; then DECODED="$DECODED $name"
    elif [ "$name" = h264 ] || [ "$name" = aac ]; then fail "decoder $name missing. Install: $(hint ffmpeg)"
    else warn "decoder $name missing: clips recorded in $name will fail to process"; fi
  done
  [ -n "$DECODED" ] && pass "decoders:$DECODED"

  FOUND=
  for fmt in mov mp4 matroska webm image2 srt; do
    if printf '%s\n' "$FORMATS" | grep -Eq "^ [A-Za-z. ]{2,3} ([a-z0-9_]+,)*$fmt[ ,]"; then FOUND="$FOUND $fmt"
    else fail "container format $fmt missing"; fi
  done
  [ -n "$FOUND" ] && pass "formats:$FOUND"

  VER="$("$FFMPEG" -hide_banner -version 2>/dev/null | head -n1 | sed -E 's/^ffmpeg version n?([0-9]+)\..*/\1/')"
  case "$VER" in
    ''|*[!0-9]*) warn "could not read the ffmpeg major version (git build?) — the functional test below is what counts" ;;
    *) if [ "$VER" -lt 4 ]; then fail "ffmpeg $VER is too old (need 4 or newer for fps eof_action)"; else pass "ffmpeg major version $VER"; fi ;;
  esac
fi

# --- run the real commands on a generated clip ------------------------------
section "ffmpeg functional test (the exact proxy, sprite, and render commands)"
if [ "$FFMPEG_OK" = 1 ]; then
  WORK="$(mktemp -d 2>/dev/null || mktemp -d -t goonvc-video)"
  trap 'rm -rf "$WORK"' EXIT
  LOG="$WORK/ffmpeg.log"
  run () { "$@" >>"$LOG" 2>&1; }
  lastlog () { tail -n 5 "$LOG" | sed 's/^/          /'; }

  if run "$FFMPEG" -y -hide_banner -nostdin \
      -f lavfi -i testsrc2=size=1280x720:rate=30:duration=4 \
      -f lavfi -i sine=frequency=440:sample_rate=48000:duration=4 \
      -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$WORK/a.mp4" \
    && run "$FFMPEG" -y -hide_banner -nostdin -f lavfi -i testsrc=size=640x480:rate=25:duration=2 \
      -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$WORK/b.mp4"; then
    pass "generated test clips (1280x720 with audio, 640x480 without)"

    if run "$FFPROBE" -v error -print_format json -show_format -show_streams "$WORK/a.mp4" && grep -q '"codec_type": "audio"' "$LOG"; then
      pass "ffprobe reads streams and duration"
    else
      fail "ffprobe could not read the test clip"; lastlog
    fi

    if run "$FFMPEG" -y -hide_banner -nostdin -i "$WORK/a.mp4" \
        -map 0:v:0 -map '0:a:0?' \
        -vf 'scale=-2:trunc(min(240\,ih)/2)*2,fps=15' \
        -c:v libx264 -preset veryfast -crf 32 -pix_fmt yuv420p \
        -c:a aac -b:a 48k -ac 2 \
        -movflags +faststart "$WORK/proxy.mp4"; then
      pass "240p / 15 fps proxy"
    else
      fail "proxy command failed:"; lastlog
    fi

    if [ -s "$WORK/proxy.mp4" ] && run "$FFMPEG" -y -hide_banner -nostdin -i "$WORK/proxy.mp4" \
        -vf 'fps=0.500000:eof_action=pass,scale=120:68,tile=2x1' \
        -frames:v 1 -q:v 5 "$WORK/thumbs.jpg" && [ -s "$WORK/thumbs.jpg" ]; then
      pass "thumbnail sprite (jpg)"
    else
      fail "thumbnail sprite command failed:"; lastlog
    fi

    printf '1\n00:00:00,000 --> 00:00:02,000\nAce · #clips\n\n2\n00:00:02,000 --> 00:00:03,500\nBix · #clips\n' > "$WORK/credits.srt"
    if run "$FFMPEG" -y -hide_banner -nostdin -nostats -progress pipe:1 \
        -ss 1 -t 2 -i "$WORK/a.mp4" -ss 0 -t 1.5 -i "$WORK/b.mp4" -i "$WORK/credits.srt" \
        -filter_complex "[0:v]setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p,trim=duration=2[v0];[0:a]asetpts=PTS-STARTPTS,aresample=48000,volume=0.8,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=2,asetpts=PTS-STARTPTS[a0];[1:v]setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p,trim=duration=1.5[v1];anullsrc=r=48000:cl=stereo,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=1.5,asetpts=PTS-STARTPTS[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]" \
        -map '[vout]' -map '[aout]' -map 2:s -c:s mov_text -metadata:s:s:0 language=eng -metadata:s:s:0 title=Sources \
        -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r 30 \
        -c:a aac -b:a 160k -ar 48000 -movflags +faststart \
        -metadata title=Check -metadata 'comment=Sources: check' "$WORK/render.mp4"; then
      STREAMS="$("$FFPROBE" -v error -show_entries stream=codec_type -of csv=p=0 "$WORK/render.mp4" 2>/dev/null | sort | tr '\n' ' ')"
      if [ "$STREAMS" = "audio subtitle video " ]; then pass "render: concat, scale/pad to 1080p, silent fill, credits subtitle track"
      else fail "render finished with streams [$STREAMS], expected audio + subtitle + video"; fi
    else
      fail "render command failed:"; lastlog
    fi
  else
    fail "could not generate a test clip (needs the lavfi input device and libx264):"; lastlog
  fi
else
  warn "skipped: ffmpeg / ffprobe missing"
fi

# --- yt-dlp ------------------------------------------------------------------
section "yt-dlp ($([ "$LINKS" = 1 ] && echo 'required: link imports are on' || echo 'optional: only for GOON_CLIPS_LINKS=1 / collect:clips --links'))"
missing_ytdlp () { if [ "$LINKS" = 1 ]; then fail "$*"; else warn "$*"; fi; }
if have "$YTDLP"; then
  YV="$("$YTDLP" --version 2>/dev/null)"
  pass "$YTDLP $YV ($(command -v "$YTDLP"))"
  # Releases are dated YYYY.MM.DD; site extractors break within weeks of a stale build.
  if printf '%s' "$YV" | grep -Eq '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}'; then
    REL="$(printf '%s' "$YV" | cut -c1-10 | tr . -)"
    NOW_S="$(date +%s)"
    REL_S="$(date -d "$REL" +%s 2>/dev/null || date -j -f %Y-%m-%d "$REL" +%s 2>/dev/null || echo "$NOW_S")"
    AGE=$(( (NOW_S - REL_S) / 86400 ))
    if [ "$AGE" -gt 60 ]; then missing_ytdlp "yt-dlp is $AGE days old; YouTube / Medal imports break on old releases. Update: $YTDLP -U, or $(hint yt-dlp)"; fi
  fi
  if ! have deno && ! have node && ! have bun; then
    missing_ytdlp "no JavaScript runtime (deno) for yt-dlp; current releases need one for YouTube"
  elif ! have deno; then
    warn "yt-dlp prefers deno for YouTube; without it some YouTube links may fail (https://deno.com)"
  fi
else
  missing_ytdlp "$YTDLP not found. Install $(hint yt-dlp)"
fi

# --- runtime, disk -----------------------------------------------------------
section "Node.js and storage"
if have node; then
  NV="$(node -v)"
  NMAJ="$(printf '%s' "$NV" | sed -E 's/^v([0-9]+).*/\1/')"
  WANT="v24.15.0"
  [ -f .nvmrc ] && WANT="$(tr -d '[:space:]' < .nvmrc)"
  if [ "$NMAJ" -lt 18 ]; then fail "node $NV is too old (needs fetch; project pins $WANT)"
  elif [ "$NV" != "$WANT" ]; then warn "node $NV (project pins $WANT)"
  else pass "node $NV"; fi
else
  fail "node not found on PATH for this shell (nvm users: run 'nvm use' first)"
fi

PROBE_DIR="$STORE"
while [ ! -d "$PROBE_DIR" ] && [ "$PROBE_DIR" != "." ] && [ "$PROBE_DIR" != "/" ]; do PROBE_DIR="$(dirname "$PROBE_DIR")"; done
if [ -w "$PROBE_DIR" ]; then
  pass "clips Store path $STORE is writable$([ -d "$STORE" ] || echo " (will be created under $PROBE_DIR)")"
else
  fail "cannot write to $PROBE_DIR (clips Store $STORE; set GOON_CLIPS_STORE)"
fi
FREE_KB="$(df -Pk "$PROBE_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "$FREE_KB" ]; then
  FREE_GB=$((FREE_KB / 1048576))
  # Originals are downloaded up to 1 GiB each before the proxy is made, and renders re-fetch them.
  if [ "$FREE_GB" -lt 2 ]; then fail "only ${FREE_GB} GB free at $PROBE_DIR (originals up to 1 GB each are downloaded while processing)"
  elif [ "$FREE_GB" -lt 10 ]; then warn "${FREE_GB} GB free at $PROBE_DIR; renders and large originals need room"
  else pass "${FREE_GB} GB free at $PROBE_DIR"; fi
fi
if [ -d "$STORE/media" ]; then
  pass "existing proxies: $(find "$STORE/media" -name '*.mp4' 2>/dev/null | wc -l | tr -d ' ') ($(du -sh "$STORE/media" 2>/dev/null | cut -f1))"
fi

# --- network -------------------------------------------------------------------
if [ "$NETWORK" = 1 ]; then
  section "Network (Discord API and attachment CDN)"
  if have curl; then
    for url in https://discord.com/api/v10/gateway https://cdn.discordapp.com/ https://media.discordapp.net/; do
      CODE="$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "$url" 2>/dev/null)"
      if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then pass "$url reachable (HTTP $CODE)"
      else fail "$url unreachable (DNS, firewall, or proxy)"; fi
    done
  else
    warn "curl not found; skipped network checks"
  fi
fi

# --- summary -------------------------------------------------------------------
printf '\n'
if [ "$FAILS" -gt 0 ]; then
  printf '%s%d problem(s)%s, %d warning(s): /clips cannot process video on this host until the FAIL lines are fixed.\n' "$R" "$FAILS" "$N" "$WARNS"
  exit 1
fi
printf '%sReady%s for /clips video processing (%d warning(s)).\n' "$G" "$N" "$WARNS"
exit 0
