// A tiny terminal for tests: applies the escape codes the TUI writes (cursor
// moves, clears, CR/LF) to a buffer of lines that holds the scrollback and the
// screen together, so tests can read what a user would see and scroll back to.

export class FakeScreen {
  lines: string[] = [""];
  row = 0;
  col = 0;
  /** How many times the screen and scrollback were cleared (\x1b[2J\x1b[3J). */
  clears = 0;

  write(s: string): void {
    let i = 0;
    while (i < s.length) {
      if (s[i] === "\x1b") {
        const csi = /^\x1b\[([?0-9;:<>]*)[ -\/]*([@-~])/.exec(s.slice(i));
        if (csi) { this.csi(csi[1]!, csi[2]!); i += csi[0].length; continue; }
        const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(s.slice(i));
        if (osc) { i += osc[0].length; continue; }
        i++;
        continue;
      }
      const ch = String.fromCodePoint(s.codePointAt(i)!);
      i += ch.length;
      if (ch === "\r") this.col = 0;
      else if (ch === "\n") { this.row++; while (this.lines.length <= this.row) this.lines.push(""); }
      else this.put(ch);
    }
  }

  private put(ch: string): void {
    const line = this.lines[this.row]!.padEnd(this.col);
    this.lines[this.row] = line.slice(0, this.col) + ch + line.slice(this.col + 1);
    this.col++;
  }

  private csi(params: string, final: string): void {
    const n = Number(params.split(";")[0]) || 0;
    if (params.startsWith("?")) return; // modes: cursor, paste, sync
    if (final === "A") this.row = Math.max(0, this.row - (n || 1));
    else if (final === "B") { this.row += n || 1; while (this.lines.length <= this.row) this.lines.push(""); }
    else if (final === "C") this.col += n || 1;
    else if (final === "D") this.col = Math.max(0, this.col - (n || 1));
    else if (final === "G") this.col = Math.max(0, n - 1);
    else if (final === "H") { this.row = 0; this.col = 0; }
    else if (final === "K") this.lines[this.row] = n === 2 ? "" : this.lines[this.row]!.slice(0, this.col);
    else if (final === "J") {
      if (n === 2 || n === 3) {
        if (n === 3) this.clears++;
        this.lines = this.lines.map(() => "");
        if (n === 3) { this.lines = [""]; this.row = 0; this.col = 0; }
      } else {
        this.lines[this.row] = this.lines[this.row]!.slice(0, this.col);
        this.lines.length = this.row + 1;
      }
    }
  }

  /** Every line, scrollback and screen, trailing spaces trimmed and trailing blank lines dropped. */
  text(): string {
    const ls = this.lines.map((l) => l.trimEnd());
    while (ls.length > 1 && ls.at(-1) === "") ls.pop();
    return ls.join("\n");
  }
}
