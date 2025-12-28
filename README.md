# CodeMedic 🩺

CodeMedic is an AI-powered Visual Studio Code extension that reviews your project code, identifies bugs, security issues, and code quality problems, and proposes safe fixes using Gemini — all through a chat-style interface.

Fixes are **never applied automatically**. CodeMedic always asks for explicit user confirmation before modifying any files.

---

## ✨ Features

- 💬 Chat-based UI inside VS Code  
- 🔍 Full workspace code review (JS / TS / HTML / CSS)  
- 🛡️ Detects bugs, security risks, and code quality issues  
- ✍️ AI-generated fixes with user approval  
- 📊 Clear summary after applying changes  
- 🔑 Uses **your own Gemini API key**  
- 🚫 No terminal commands  
- 🚫 No access outside workspace  
- 🚫 No silent overwrites  

---

## 🚀 Getting Started

### 1️⃣ Install the Extension
- Install from the VS Code Marketplace (once published), or
- Install locally using the `.vsix` file

---

### 2️⃣ Add Your Gemini API Key

CodeMedic requires a Gemini API key.

Open **VS Code Settings** and add:

```json
{
  "codemedic.apiKey": "YOUR_GEMINI_API_KEY"
}
