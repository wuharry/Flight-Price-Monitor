import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export type CommandRunner = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<unknown>;
const defaultRunner: CommandRunner = (file, args, env) =>
  execFileAsync(file, args, { env, timeout: 10000, windowsHide: true });

// PowerShell reads the text from the environment, so nothing has to be escaped for it.
const powershell = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $xml.GetElementsByTagName('text')
$text.Item(0).AppendChild($xml.CreateTextNode($env:FLIGHT_NOTIFY_TITLE)) > $null
$text.Item(1).AppendChild($xml.CreateTextNode($env:FLIGHT_NOTIFY_BODY)) > $null
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show(
  [Windows.UI.Notifications.ToastNotification]::new($xml))
`;

// AppleScript cannot read the text from the environment: `system attribute` fails to coerce
// characters such as ✈ and stops with error -1700. The text is embedded in the script instead,
// with every backslash and quote escaped so a route or rule name cannot close the string literal
// and append AppleScript of its own.
const appleScriptString = (text: string) =>
  '"' + text.replace(/[\\"]/g, character => '\\' + character).replace(/[\r\n]+/g, ' ') + '"';

export async function notifyDesktop(title: string, body: string, runner: CommandRunner = defaultRunner) {
  const command: [string, string[]] | undefined =
    process.platform === 'win32' ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', powershell]] :
    process.platform === 'darwin' ? ['osascript', ['-e',
      `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`]] :
    process.platform === 'linux' ? ['notify-send', [title, body]] : undefined;
  if (!command) { console.warn(`[Notify] No desktop notifier for platform ${process.platform}`); return false; }
  try {
    await runner(command[0], command[1], { ...process.env, FLIGHT_NOTIFY_TITLE: title, FLIGHT_NOTIFY_BODY: body });
    console.log(`[Notify] Desktop notification sent via ${command[0]}`);
    return true;
  } catch (error) {
    // A headless server, a locked session or a missing notification daemon must never fail a price check.
    console.warn('[Notify] Desktop notification skipped: ' + (error as Error).message.split('\n')[0]);
    return false;
  }
}
