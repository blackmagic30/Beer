#!/usr/bin/env -S -i /bin/zsh -f
set -eu

if [ "$#" -lt 1 ] || [ "$0" != "./scripts/run-locked-sensitive-worker.sh" ]; then
  exit 64
fi

locked_mode=$1
shift
case "$locked_mode" in
  attestor|planner) ;;
  *) exit 64 ;;
esac

locked_repo_root=/Users/zac/Desktop/Beer
if [ "$(/bin/pwd -P)" != "$locked_repo_root" ]; then
  exit 69
fi
locked_launcher="$locked_repo_root/scripts/run-locked-sensitive-worker.sh"
locked_preload="$locked_repo_root/scripts/lib/locked-sensitive-worker-primordials.mjs"
locked_tsx_package="$locked_repo_root/node_modules/tsx/package.json"
locked_tsx="$locked_repo_root/node_modules/tsx/dist/loader.mjs"
locked_worker="$locked_repo_root/scripts/run-locked-sensitive-worker.ts"
locked_home=/Users/zac
locked_node=/Users/zac/.nvm/versions/node/v22.23.2/bin/node
locked_expected_tsx_version=4.23.12
locked_expected_tsx_loader_sha256=49fb46730ddeb226ac4fa9fb990d3573ac8f18fa4de02f1bf723c61d715710c2

if [ ! -x "$locked_node" ] \
  || [ -L "$locked_node" ] \
  || [ ! -f "$locked_launcher" ] \
  || [ -L "$locked_launcher" ] \
  || [ ! -f "$locked_preload" ] \
  || [ -L "$locked_preload" ] \
  || [ ! -f "$locked_tsx_package" ] \
  || [ -L "$locked_tsx_package" ] \
  || [ ! -f "$locked_tsx" ] \
  || [ -L "$locked_tsx" ] \
  || [ ! -f "$locked_worker" ] \
  || [ -L "$locked_worker" ]; then
  exit 69
fi

locked_scripts_real=$(CDPATH= cd -P -- "$locked_repo_root/scripts" && /bin/pwd -P) \
  || exit 69
locked_lib_real=$(CDPATH= cd -P -- "$locked_repo_root/scripts/lib" && /bin/pwd -P) \
  || exit 69
locked_tsx_root_real=$(CDPATH= cd -P -- "$locked_repo_root/node_modules/tsx" && /bin/pwd -P) \
  || exit 69
locked_tsx_real=$(CDPATH= cd -P -- "$locked_repo_root/node_modules/tsx/dist" && /bin/pwd -P) \
  || exit 69
if [ "$locked_scripts_real" != "$locked_repo_root/scripts" ] \
  || [ "$locked_lib_real" != "$locked_repo_root/scripts/lib" ] \
  || [ "$locked_tsx_root_real" != "$locked_repo_root/node_modules/tsx" ] \
  || [ "$locked_tsx_real" != "$locked_repo_root/node_modules/tsx/dist" ]; then
  exit 69
fi

locked_actual_tsx_version=$(
  /usr/bin/env -i \
    HOME="$locked_home" \
    LANG=C \
    LOGNAME=zac \
    PATH=/usr/bin:/bin \
    USER=zac \
    "$locked_node" \
    --input-type=module \
    --eval 'import fs from "node:fs";
      let version = "";
      try {
        const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (parsed && Object.getPrototypeOf(parsed) === Object.prototype
          && typeof parsed.version === "string") version = parsed.version;
      } catch {}
      if (version === "") process.exitCode = 69;
      else process.stdout.write(version);' \
    "$locked_tsx_package"
) || exit 69
locked_actual_tsx_loader_sha256=$(/usr/bin/shasum -a 256 "$locked_tsx") \
  || exit 69
locked_actual_tsx_loader_sha256=${locked_actual_tsx_loader_sha256%% *}
if [ "$locked_actual_tsx_version" != "$locked_expected_tsx_version" ] \
  || [ "$locked_actual_tsx_loader_sha256" != "$locked_expected_tsx_loader_sha256" ]; then
  exit 69
fi

exec /usr/bin/env -i \
  __CF_USER_TEXT_ENCODING=0x1F5:0:0 \
  HOME="$locked_home" \
  LANG=C \
  LOGNAME=zac \
  PATH=/usr/bin:/bin \
  USER=zac \
  "$locked_node" \
  --disable-sigusr1 \
  --disable-warning=ExperimentalWarning \
  --frozen-intrinsics \
  --import "$locked_preload" \
  --import "$locked_tsx" \
  "$locked_worker" \
  "$locked_mode" \
  "$@"
