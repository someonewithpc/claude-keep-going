{ config, lib, pkgs, ... }:
let
  cfg = config.programs.claude-keep-going;
  common = import ./common.nix { inherit lib pkgs config; };

  # launchd jobs don't inherit the login shell's PATH, so `spawn tmux` in
  # reconcile would ENOENT even though the CLI itself is invoked by absolute
  # path. Derived from the packages this module actually installs (cfg.package,
  # tmux) rather than guessed profile locations, so it can't drift from them;
  # /usr/bin:/bin cover the handful of bare system utilities (ps, etc.) reconcile
  # also shells out to.
  darwinAgentPath = lib.makeBinPath [ cfg.package pkgs.tmux ] + ":/usr/bin:/bin";
in
{
  options.programs.claude-keep-going = common.options;

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      # tmux is a hard runtime dependency (not just a suggestion): the wrapper only
      # works inside tmux, and reconcile/monitor both spawn the `tmux` binary directly.
      home.packages = [ cfg.package pkgs.tmux ];

      programs.bash.initExtra = lib.mkIf cfg.shellIntegration.bash (common.wrapperScript cfg);
      programs.zsh.initContent = lib.mkIf cfg.shellIntegration.zsh (common.wrapperScript cfg);

      # Unlike the NixOS module (no per-user activation hook available at the
      # system level), home-manager's own activation runs exactly once per
      # generation switch, precisely when cfg.package's store path can have
      # changed, so install-hook belongs here instead of on the reconcile
      # timer, which would otherwise re-run it (and rewrite settings.json)
      # every `reconcileTimer.interval` for no reason between switches.
      # Moves files left in ~/.claude-auto-retry* by older versions; a no-op once done.
      home.activation.claudeKeepGoingMigrate = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        run ${cfg.package}/bin/claude-keep-going migrate --yes --quiet
      '';

      home.activation.claudeKeepGoingInstallHook = lib.mkIf cfg.installHook (
        lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          run ${cfg.package}/bin/claude-keep-going install-hook
        ''
      );
    }

    (lib.mkIf (cfg.reconcileTimer.enable && pkgs.stdenv.hostPlatform.isLinux) {
      systemd.user.services.claude-keep-going-reconcile = {
        Unit = {
          Description = "claude-keep-going: re-arm monitors for all live claude tmux panes";
          After = [ "graphical-session.target" ];
        };
        Service = {
          Type = "oneshot";
          # reconcile spawns detached monitor processes and exits; the default
          # KillMode=control-group would kill them along with it.
          KillMode = "process";
          ExecStart = "${cfg.package}/bin/claude-keep-going reconcile";
        };
      };

      systemd.user.timers.claude-keep-going-reconcile = {
        Unit.Description = "Periodically reconcile claude-keep-going monitors (self-healing coverage)";
        Timer = {
          OnStartupSec = cfg.reconcileTimer.startupDelay;
          OnUnitActiveSec = cfg.reconcileTimer.interval;
        };
        Install.WantedBy = [ "timers.target" ];
      };
    })

    (lib.mkIf (cfg.reconcileTimer.enable && pkgs.stdenv.hostPlatform.isDarwin) {
      launchd.agents.claude-keep-going-reconcile = {
        enable = true;
        config = {
          ProgramArguments = [ "${cfg.package}/bin/claude-keep-going" "reconcile" ];
          AbandonProcessGroup = true;
          RunAtLoad = true;
          StartInterval = 300;
          ProcessType = "Background";
          EnvironmentVariables.PATH = darwinAgentPath;
        };
      };
    })
  ]);
}
