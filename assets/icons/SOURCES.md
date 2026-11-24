# Icon sources

Provider icons in `assets/icons/` were selected with the `dashboard-icons` MCP
server (`https://dashboardicons.com/api/mcp`, tools `match_icons` and
`search_icons`) and downloaded once at development time. The plugin serves
these local files; it does not call the MCP server at runtime.

| Provider | File | Catalog | Source URL |
|---|---|---|---|
| DSH | `dsh.svg` | Dashboard Icons (native) | https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/deepseek.svg |
| Codex | `codex.svg` | Dashboard Icons (native) | https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/openai.svg |
| Claude Code | `claude.svg` | Dashboard Icons (native) | https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/anthropic.svg |
| Cursor | `cursor.svg` | LobeHub icons | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/cursor.svg |
| LocalAgent | `localagent.svg` | LobeHub icons (`codeflicker`) | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/codeflicker-color.svg |
| Grok Bot | `grokbot.svg` | LobeHub icons | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/grokbot.svg |
| Antigravity | `antigravity.svg` | LobeHub icons | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/antigravity-color.svg |

The files were reduced to `viewBox` plus drawing content, with scripts, external
references, and inline event handlers removed. Brand marks and logos are
trademarks of their owners and are used here only to identify the monitored
agents.
