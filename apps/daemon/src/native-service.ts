import { spawn } from "node:child_process";

function run(executable: string, args: string[], input?: string): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    if (input) child.stdin?.end(input);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr });
      else reject(new Error(stderr.trim() || `${executable} exited with code ${code}`));
    });
  });
}

export class NativeService {
  async notify(title: string, body: string): Promise<void> {
    if (process.platform === "darwin") {
      const script = "function run(a){var app=Application.currentApplication();app.includeStandardAdditions=true;app.displayNotification(a[1],{withTitle:a[0]});}";
      await run("osascript", ["-l", "JavaScript", "-e", script, title, body]);
      return;
    }
    if (process.platform === "linux") {
      await run("notify-send", [title, body]);
      return;
    }
    throw new Error(`Desktop notifications are not supported on ${process.platform}`);
  }

  async readClipboardImage(): Promise<{ mimeType: string; base64: string }> {
    if (process.platform === "darwin") {
      const script = `ObjC.import('AppKit');
function run(){var p=$.NSPasteboard.generalPasteboard;var types=['public.png','public.tiff'];
for(var i=0;i<types.length;i++){var d=p.dataForType(types[i]);if(d){return types[i]+'\\n'+ObjC.unwrap(d.base64EncodedStringWithOptions(0));}}
throw new Error('Clipboard does not contain a PNG or TIFF image');}`;
      const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", script]);
      const [type, ...data] = stdout.toString("utf8").trim().split("\n");
      return { mimeType: type === "public.tiff" ? "image/tiff" : "image/png", base64: data.join("") };
    }
    if (process.platform === "linux") {
      try {
        const { stdout } = await run("wl-paste", ["--no-newline", "--type", "image/png"]);
        return { mimeType: "image/png", base64: stdout.toString("base64") };
      } catch {
        const { stdout } = await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
        return { mimeType: "image/png", base64: stdout.toString("base64") };
      }
    }
    throw new Error(`Clipboard image reading is not supported on ${process.platform}`);
  }
}
