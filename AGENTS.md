# Project Instructions

Get this computer ready and install REA (Reverse Engineer Anything) for OpenCode.
REA's official page: https://github.com/morluto/rea — use only this official source.

## Rules

- Do everything yourself. Never ask me anything, except the one question in step 3.
- Before every check, download, install and engine you use, print one clear line first: what it is and why you need it. Then go forward.
- If something is already installed and works, leave it alone.
- If you need my computer password, stop and tell me.

## Steps

1. Check this computer yourself, in your terminal: Node.js, npm, Git, the Claude Code
   command-line tool (`claude`), and everything else REA needs. Install or update only
   what's missing or too old, the official way for this computer. For Claude Code, use
   Anthropic's official installer.

2. Install REA with its official installer:

   ```
   npx rea-agents@latest setup --client opencode --yes
   ```

3. Before installing any analysis engine, read properly what each engine is for. Then ask
   me one question only — what is your use case: a website, an app, or something else? —
   and wait for my answer. Then download and install every engine my use case needs, from
   its official source, and check that each one works. Skip the rest.

4. Find out which version of OpenCode I have and read its settings docs. In OpenCode's
   settings file, give REA up to 2 minutes to start and let each REA job run for at least
   30 minutes, using the exact format my version expects. If a limit is already longer,
   leave it. Then check the settings file is still valid.

5. Run REA's check for OpenCode: `npx rea-agents doctor --client opencode` — fix anything
   broken and run it again until it passes. Engines we skipped on purpose don't count.
