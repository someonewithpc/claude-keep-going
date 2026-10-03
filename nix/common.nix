{ lib, pkgs, config }:
{
  options = {
    enable = lib.mkEnableOption "claude-keep-going (auto-resume Claude Code on subscription rate limits and API overload)";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage <claude-keep-going>/nix/package.nix { }";
      description = "The claude-keep-going package to use.";
    };

    shellIntegration = {
      bash = lib.mkOption {
        type = lib.types.bool;
        default = config.programs.bash.enable;
        description = "Wrap the `claude` command for interactive bash shells.";
      };
      zsh = lib.mkOption {
        type = lib.types.bool;
        default = config.programs.zsh.enable;
        description = "Wrap the `claude` command for interactive zsh shells.";
      };
    };

    settings = lib.mkOption {
      type = (pkgs.formats.json { }).type;
      default = { };
      example = lib.literalExpression ''
        {
          maxRetries = 3;
          overload.maxTotalWaitMinutes = 60;
        }
      '';
      description = ''
        Configuration written as JSON for claude-keep-going (see the README's
        Configuration section for the keys). The NixOS module writes it to
        /etc/xdg/claude-keep-going/config.json, the home-manager module to
        ~/.config/claude-keep-going/config.json. A user file still overrides the
        system one key by key. Empty means no file is written.
      '';
    };

    installHook = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Install the `StopFailure` hook into Claude Code's settings for
        event-driven overload detection (no terminal scraping). The hook
        command embeds this package's store path, so it is re-applied on
        every reconcile run to stay in sync across upgrades. `install-hook`
        is idempotent, matching its previous entry by a fixed marker rather
        than the old path.
      '';
    };

    reconcileTimer = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Run `claude-keep-going reconcile` on a timer (systemd --user on
          Linux, a launchd agent on Darwin), so a monitor that dies (or a
          `claude` started outside the wrapper) gets covered within one
          interval instead of staying unmonitored forever.
        '';
      };
      startupDelay = lib.mkOption {
        type = lib.types.str;
        default = "2min";
        description = "How long after the user session starts before the first reconcile run (lets tmux settle). Linux only; the launchd agent always runs at load.";
      };
      interval = lib.mkOption {
        type = lib.types.str;
        default = "5min";
        description = "How often to re-run reconcile after the first run.";
      };
    };
  };

  # The wrapper's own template already branches on $ZSH_VERSION at runtime, so
  # the same substituted script is sourced by both bash and zsh (see src/wrapper.sh).
  wrapperScript = cfg: builtins.replaceStrings
    [ "__LAUNCHER_PATH__" ]
    [ cfg.package.launcherPath ]
    (builtins.readFile cfg.package.wrapperTemplatePath);
}
