import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue === undefined ? "" : ` (${defaultValue})`;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || "";
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const marker = defaultYes ? "Y/n" : "y/N";
  const answer = (await ask(`${question} [${marker}]`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

export async function askHidden(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error(`${question} must be provided through USC_BS_CLIENT_SECRET in a non-interactive shell.`);
  }

  stdout.write(`${question}: `);
  stdin.setRawMode(true);
  stdin.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = "";

    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (data: Buffer) => {
      const text = data.toString("utf8");
      if (text === "\u0003") {
        finish(new Error("Cancelled."));
        return;
      }
      if (text === "\r" || text === "\n") {
        finish();
        return;
      }
      if (text === "\u007f" || text === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write("\b \b");
        }
        return;
      }
      if (/^[\x20-\x7e]+$/.test(text)) {
        value += text;
        stdout.write("*".repeat(text.length));
      }
    };

    stdin.on("data", onData);
  });
}
