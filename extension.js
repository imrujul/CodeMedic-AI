const vscode = require('vscode');

let currentPanel;
let pendingFixes = null;

const history = [];
const MAX_TURNS = 6; // last 6 user+model pairs

// /**
//  * @param {vscode.ExtensionContext} context
//  */

function trimHistory() {
  const maxEntries = MAX_TURNS * 2;
  if (history.length > maxEntries) {
    history.splice(0, history.length - maxEntries);
  }
}

function isCodeReviewRequest(text) {
  const t = text.toLowerCase();

  return (
    t.includes('review') ||
    t.includes('analyse') ||
    t.includes('analyze') ||
    t.includes('check') ||
    t.includes('bug') ||
    t.includes('issue') ||
    t.includes('fix') ||
    t.includes('correct') ||
    t.includes('improve') ||
    t.includes('code') && t.includes('file')
  );
}


// Read workspace files safely
async function readWorkspaceFiles() {
  const uris = await vscode.workspace.findFiles(
    '**/*.{js,ts,jsx,tsx,html,css}',
    '**/{node_modules,dist,build}/**'
  );

  const files = [];

  for (const uri of uris.slice(0, 10)) { // safety limit
    const data = await vscode.workspace.fs.readFile(uri);
    files.push({
      path: uri.fsPath,
      content: Buffer.from(data).toString('utf8')
    });
  }

  return files;
}

// Build review prompt
function buildReviewPrompt(files) {
  return `
You are a senior software engineer.

RETURN ONLY VALID JSON.
DO NOT add markdown.
DO NOT add explanations.
DO NOT wrap in \`\`\`.
DO NOT add the word "json".

JSON SCHEMA (MUST MATCH EXACTLY):
{
  "files": [
    {
      "path": "relative/path/to/file.js",
      "issues": ["string"],
      "fixedCode": "FULL corrected file content"
    }
  ]
}

FILES:
${files.map(f => `
--- ${f.path} ---
${f.content}
`).join('\n')}
`;
}


async function getGeminiClient() {
  const config = vscode.workspace.getConfiguration('codemedic');
  const apiKey = config.get('apiKey');

  if (!apiKey) {
    throw new Error('Gemini API key is not set. Please add it in CodeMedic settings.');
  }

  const { GoogleGenAI } = await import('@google/genai');

  return new GoogleGenAI({ apiKey });
}

function extractJson(text) {
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('No JSON object found in response');
  }
  return text.slice(firstBrace, lastBrace + 1);
}

function buildFixSummary(fixes) {
  return fixes.files.map(file => {
    const fileName = file.path.split(/[\\/]/).pop();
    return `• ${fileName} – ${file.issues.slice(0, 2).join(', ')}`;
  }).join('\n');
}


function activate(context) {
  const openChatCommand = vscode.commands.registerCommand(
    'codemedic.openChat',
    async () => {

      if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        return;
      }

      const config = vscode.workspace.getConfiguration('codemedic');
      // const apiKey = config.get('apiKey');

      if (!config.get('apiKey')) {
        const choice = await vscode.window.showWarningMessage(
          'CodeMedic requires a Gemini API key.',
          'Open Settings'
        );
        if (choice === 'Open Settings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'codemedic.apiKey'
          );
        }
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        'codemedicChat',
        'CodeMedic Chat',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );

      currentPanel = panel;

      panel.onDidDispose(() => {
        currentPanel = undefined;
        history.length = 0; // Reset chat on close
      });

      // MESSAGE HANDLER

      panel.webview.onDidReceiveMessage(async (message) => {
        if (message.type !== 'userMessage') return;

        try {
          const ai = await getGeminiClient();

          if (isCodeReviewRequest(message.text)) {

            panel.webview.postMessage({
              type: 'botReply',
              text: 'Checking your code, please wait...'
            });
            const files = await readWorkspaceFiles();
            panel.webview.postMessage({
              type: 'botReply',
              text: 'Reviewing workspace files...'
            });


            if (files.length === 0) {
              panel.webview.postMessage({
                type: 'botReply',
                text: 'No supported code files found in this workspace.'
              });
              return;
            }

            const prompt = buildReviewPrompt(files);

            const result = await ai.models.generateContent({
              model: 'gemini-2.5-flash',
              config: {
                systemInstruction: `You are CodeMedic, a coding-only AI assistant.
                RULES (MANDATORY):
                - Answer ONLY questions related to programming, software development, or computer science.
                - If the user asks anything NOT related to coding, reply like :"I only answer questions related to coding and software development."
                - Reply normally to greetings like hello, hi, can you help me, etc.`
              },
              contents: [
                { role: 'user', parts: [{ text: prompt }] }
              ]
            });

            const raw = result.candidates?.[0]?.content?.parts?.[0]?.text;

            try {

              const cleanJson = extractJson(raw);
              pendingFixes = JSON.parse(cleanJson);

              if (!pendingFixes.files || pendingFixes.files.length === 0) {
                pendingFixes = null;

                panel.webview.postMessage({
                  type: 'botReply',
                  text: '✅ No issues found. Your code looks good.'
                });

                return;
              }


              panel.webview.postMessage({
                type: 'botReply',
                text: 'I found issues and prepared fixes. Do you want me to apply them? (Yes / No)'
              });

            } catch {
              panel.webview.postMessage({
                type: 'botReply',
                text: raw // fallback if model fails JSON
              });
            }

            return;
          }

          if (pendingFixes && ['yes', 'apply'].includes(message.text.toLowerCase())) {
            await applyFixes(pendingFixes);

            const summary = buildFixSummary(pendingFixes);

            panel.webview.postMessage({
              type: 'botReply',
              text: `✅ Fixes applied successfully.\n\nSummary:\n${summary}`
            });

            pendingFixes = null;
            return;
          }


          if (pendingFixes && message.text.toLowerCase() === 'no') {
            pendingFixes = null;
            panel.webview.postMessage({
              type: 'botReply',
              text: 'Okay, fixes were not applied.'
            });
            return;
          }

          // Add user message to history| normal chat mode 
          history.push({
            role: 'user',
            parts: [{ text: message.text }]
          });

          const result = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            config: {
              systemInstruction: `You are CodeMedic, a coding-only AI assistant.
              RULES (MANDATORY):
              - Answer ONLY questions related to programming, software development, or computer science.
              - If the user asks anything NOT related to coding, reply like:"I only answer questions related to coding and software development."
              - Reply normally to greetings like hello, hi, can you help me, etc.`
            },
            contents: history
          });

          const reply =
            result.candidates?.[0]?.content?.parts?.[0]?.text ||
            'Sorry, I could not generate a response.';

          // Add model reply to history
          history.push({
            role: 'model',
            parts: [{ text: reply }]
          });
          trimHistory();

          // Send reply to UI
          panel.webview.postMessage({
            type: 'botReply',
            text: reply
          });

        } catch (err) {
          panel.webview.postMessage({
            type: 'botReply',
            text: '⚠️ Error: ' + err.message
          });
        }
      });

      // SET HTML LAST
      panel.webview.html = getChatHtml();
    }
  );

  context.subscriptions.push(openChatCommand);
}

async function applyFixes(data) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error('No workspace folder found.');
  }

  for (const file of data.files) {
    if (!file.fixedCode || typeof file.fixedCode !== 'string') {
      throw new Error(`Invalid fixedCode for ${file.path}`);
    }

    const uri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      file.path
    );

    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(file.fixedCode, 'utf8')
    );
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function deactivate() { }

function getChatHtml() {
  const nonce = getNonce();

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  
    <style>
      body {
        margin: 0 auto;
        margin-top: 10px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        background: #1e1e1e;
        color: #ddd;
        display: flex;
        flex-direction: column;
        height: 100vh;
        max-width: 420px;
      }

      header {
        padding: 12px;
        background: #252526;
        text-align: center;
        font-weight: bold;
        border-bottom: 1px solid #333;
      }

      #chat {
        flex: 1;
        padding: 12px;
        overflow-y: auto;
      }

      .message {
        max-width: 75%;
        padding: 10px 12px;
        margin-bottom: 10px;
        border-radius: 8px;
        line-height: 1.4;
        word-wrap: break-word;
      }

      .user {
        background: #0e639c;
        color: #fff;
        margin-left: auto;
        border-bottom-right-radius: 2px;
      }

      .bot {
        background: #333;
        color: #ddd;
        margin-right: auto;
        border-bottom-left-radius: 2px;
      }

      footer {
        display: flex;
        padding: 10px;
        border-top: 1px solid #333;
        background: #252526;
        margin-bottom: 10px;
      }

      input {
        flex: 1;
        padding: 8px;
        border-radius: 4px;
        border: none;
        outline: none;
        background: #1e1e1e;
        color: #fff;
      }

      button {
        margin-left: 8px;
        padding: 8px 14px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        background: #0e639c;
        color: #fff;
      }

      button:hover {
        background: #1177bb;
      }
    </style>
  </head>
  <body>
    <header>CodeMedic Chat</header>

    <div id="chat"></div>

    <footer>
      <input id="input" placeholder="Ask CodeMedic…" />
      <button  id="sendBtn" type="button" >Send</button>
    </footer>

    <script nonce="${nonce}">
    console.log('WEBVIEW SCRIPT LOADED');
    alert('Webview JS Loaded');

      const vscode = acquireVsCodeApi();
      const input = document.getElementById('input');
      const chat = document.getElementById('chat');
      const sendBtn = document.getElementById('sendBtn');
      
      sendBtn.addEventListener('click',()=>{
        console.log('SEND BUTTON CLICKED');
        send();
        });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') send();
      });

      function send() {
      const text =input.value.trim();
        if (!text) return;

        addMessage(text, 'user');

        vscode.postMessage({
          type: 'userMessage',
          text
        });

        input.value = '';
      }

      window.addEventListener('message', event => {
        if (event.data.type === 'botReply') {
          addMessage(event.data.text, 'bot');
        }
      });

      function addMessage(text, type) {
        const div = document.createElement('div');
        div.className = 'message ' + type;
        div.textContent = text;
        chat.appendChild(div);
        chat.scrollTop = chat.scrollHeight;
      }
    </script>
  </body>
  </html>
  `;
}

module.exports = {
  activate,
  deactivate
};
