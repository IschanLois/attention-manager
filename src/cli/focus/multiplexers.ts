import { runAll, type FocusAdapter } from "./types.ts";

export const tmuxAdapter: FocusAdapter = {
  id: "tmux",
  role: "multiplexer",
  applies: (info) => Boolean(info.tmux),
  run(info, ctx) {
    const { socket, pane } = info.tmux!;
    const tmux = (...args: string[]): [string, string[]] => ["tmux", ["-S", socket, ...args]];
    const sameServer = ctx.env.TMUX?.split(",")[0] === socket;
    return runAll(ctx, [
      tmux("select-window", "-t", pane),
      tmux("select-pane", "-t", pane),
      ...(sameServer ? [tmux("switch-client", "-t", pane)] : []),
    ]);
  },
  manualCommand(info) {
    const { socket, pane } = info.tmux!;
    return `tmux -S ${socket} select-window -t ${pane} \\; select-pane -t ${pane}`;
  },
};

export const screenAdapter: FocusAdapter = {
  id: "screen",
  role: "multiplexer",
  applies: (info) => Boolean(info.screen?.window),
  run(info, ctx) {
    const { sty, window } = info.screen!;
    return runAll(ctx, [["screen", ["-S", sty, "-X", "select", window!]]]);
  },
  manualCommand(info) {
    return info.screen?.window ? `screen -r ${info.screen.sty} -p ${info.screen.window}` : null;
  },
};
