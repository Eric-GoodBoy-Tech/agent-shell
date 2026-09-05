#!/usr/bin/env zsh
#===============================================================================
# agent.zsh — Agent Shell bootstrap script
#===============================================================================
# Usage: source agent.zsh
# Embeds Agent functionality into the current zsh session.
#
# Dependencies:
#   - jq (JSON processing)
#   - bun (runs agsh CLI)
#===============================================================================

# ─── Environment loading ───────────────────────────────────────────────────
#
# Layering, applied bottom-up (later layers may override earlier ones):
#   defaults → .env → user environment → ~/.agshrc → .agshrc
#
# .env and defaults use fill-gap semantics: they set a variable only when it is
# not already in the environment. ~/.agshrc and .agshrc are sourced as-is, near
# the end of this file (see "User and project config").
#
export AGENT_ROOT="${AGENT_ROOT:-${0:A:h}}"

# Layer 1 — .env: fill gaps only
if [[ -f "$AGENT_ROOT/.env" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    key="${key%%[[:space:]]*}"
    : ${(P)key:="$value"}
    export "$key"
  done < "$AGENT_ROOT/.env"
fi

# Layer 2 — defaults: fill gaps only
: ${AGENT_EXEC_DELAY:=2}
: ${AGENT_OUTPUT_MAX_LENGTH:=10000}
: ${AGENT_DEBUG:=false}
: ${AGENT_POLL_INTERVAL:=0.05}
: ${AGENT_NODES_PATH:=".agsh/nodes"}
# Export the shell-owned knobs so the CLI subprocess sees the same values
# (single source of truth for their defaults: this layer, not src/config.ts).
# AGENT_NODES_PATH is exported below, after being made absolute.
export AGENT_EXEC_DELAY AGENT_OUTPUT_MAX_LENGTH AGENT_DEBUG AGENT_POLL_INTERVAL

# ─── Kernel text slots ───────────────────────────────────────────────────────
# User-facing text is not inlined at call sites: each surface is a *function
# slot* whose default implementation is defined further down ("help slot" and
# "credential text slots"). The kernel calls the slot by name and zsh resolves
# the name when it is *called*, so redefining the same name later takes over --
# no alias, and no dependence on load order.
: ${_AGENT_BANNER_TEXT:='  credential - Claim/release a credential
  Ctrl+G     - Pause/resume
  Ctrl+T     - Retry API
  Type agent help for the full command list
  agent unload - Unload agent-shell
'}

# ~/.agshrc and .agshrc are sourced near the *end* of this file -- once every
# definition above is in place, and before AGENT_NODES_PATH is made absolute
# (see "User and project config").

# ─── Idempotency guard ──────────────────────────────────────────────────────
[[ -n "${_AGENT_SOURCED:-}" ]] && { _agent_debug_log "[agent] already sourced"; return 1; }
_AGENT_SOURCED=1

# ─── CLI ready check ───────────────────────────────────────────────────────────────
_agent_cli_ready() {
  command -v bun >/dev/null 2>&1 || {
    echo "[agent] ERROR: bun not found — CLI cannot run" >&2
    return 1
  }
  [[ -f "$AGENT_ROOT/src/cli.ts" ]] || {
    echo "[agent] ERROR: src/cli.ts not found — CLI source missing" >&2
    return 1
  }
  return 0
}

# _agent_bun_cli: unified CLI entry. Reads AGENT_PRELOAD (a space-separated
# preload path list); when non-empty, splits it word-wise and appends one
# --preload=<p> per entry, then runs src/cli.ts via bun.
# Core is preload-agnostic: it never looks up plug files nor knows plug
# identities — it only consumes this env interface.
_agent_bun_cli() {
  _agent_cli_ready || return 1
  local -a preload_args=()
  local p
  for p in ${=AGENT_PRELOAD:-}; do
    preload_args+=(--preload="$p")
  done
  bun run "${preload_args[@]}" "$AGENT_ROOT/src/cli.ts" "$@"
}

# Help slot: the kernel's own default implementation (English). agent() calls
# `_agent_help`; a later definition of that name replaces this one.
_agent_help() {
  echo "agent-shell - terminal-native AI agent"
  echo ""
  echo "Commands:"
  echo "  credential claim <id>           Claim a credential and start the agent (switchable anytime)"
  echo "  credential drop                 Release the credential and stop the agent"
  echo "  agent help                      Show this help"
  echo "  agent unload                    Unload agent-shell, restore the original shell"
  echo "  agent debug tail                Follow the debug log (tail -f)"
  echo "  agent debug cat                 Print the debug log (cat)"
  echo ""
  echo "Keybindings:"
  echo "  Ctrl+G  Pause/resume the agent"
  echo "  Ctrl+T  Retry the last API request"
  echo ""
  echo "Env:"
  echo "  AGENT_API_KEY                   (required) API key"
  echo "  AGENT_BASE_URL                  API endpoint"
  echo "  AGENT_MODEL                     Model name"
  echo "  AGENT_EXEC_DELAY=2              Seconds before auto-executing commands"
  echo "  AGENT_OUTPUT_MAX_LENGTH=10000   Max tool output length (chars)"
  echo "  AGENT_DEBUG=false               Debug logging"
  echo "  AGENT_EXEC_TIMEOUT=0            Command execution timeout (seconds, 0=off)"
  echo "  AGENT_REASONING_EFFORT=high     Reasoning depth"
  echo "  AGENT_API_TTFT_TIMEOUT=120      Time-to-first-token timeout (seconds)"
}

agent() {
  case "${1:-help}" in
    help|--help|-h)
      _agent_help
      ;;
    unload)
      _agent_unload
      ;;
    response)
        if [[ -n "${CREDENTIAL:-}" ]]; then
          local _hist="$AGENT_NODES_PATH/$CREDENTIAL/history"
          [[ -f "$_hist" ]] && tail -1 "$_hist" | jq -r '.[-1].content // empty' 2>/dev/null
        fi
        ;;
    debug)
      case "${2:-}" in
        tail) [[ -n "${_AGENT_DEBUG_LOG:-}" ]] && tail -f "$_AGENT_DEBUG_LOG" || echo "[agent] debug log not active (set AGENT_DEBUG=true)" >&2 ;;
        cat)  [[ -n "${_AGENT_DEBUG_LOG:-}" && -f "$_AGENT_DEBUG_LOG" ]] && cat "$_AGENT_DEBUG_LOG" || echo "[agent] debug log not found (set AGENT_DEBUG=true)" >&2 ;;
        *)    echo "agent debug tail  — follow debug log" >&2; echo "agent debug cat   — print debug log" >&2 ;;
      esac
      ;;

    *)
      echo "agent: unknown command '$1'. Try 'agent help'." >&2
      return 1
      ;;
  esac
}
export -f agent >/dev/null 2>&1 || true

# ═══════════════════════════════════════════════════════════════════
# PIPELINE STATE INITIALIZATION
#   Agent state machine: _AGENT_LOCKED, _AGENT_ARTIFACT_DIR, _AGENT_PENDING_CMD
#   State truth: AGENT_STATUS (JSON) — core writes it, plug layer renders it (see PIPELINE 1+3)
#   General: AGENT_FIFO_STATE, _AGENT_CACHED_PROMPT, AGENT_FIFO_FD, etc.
# ═══════════════════════════════════════════════════════════════════

# Agent cycle lock — non-empty = agent is working, precmd should skip
_AGENT_LOCKED=""
_AGENT_ARTIFACT_DIR=""
_AGENT_PENDING_CMD=""

# Async agent state
AGENT_FIFO_STATE=""
AGENT_FIFO_FD=""
AGENT_API_PID=""
_AGENT_EXEC_TOOL_ID=""
_AGENT_IN_TMUX=""
_AGENT_DEBUG_LOG=""
_AGENT_CAPTURE=""               # flag: agent-initiated command in accept-line pipeline
_AGENT_CAPTURE_CRED_BEFORE=""   # credential snapshot for drop scenario
# Single-variable state truth: AGENT_STATUS (JSON; vocabulary: idle/paused/streaming/api_done/error/fatal + optional fields); rendering belongs to the plug layer
AGENT_STATUS='{"state":"idle"}'

# ─── Tmux detection ──────────────────────────────────────────────────────────
# Auto-enter (Enter injection) and exec-timeout (C-c injection) rely on tmux send-keys.
if [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" ]] && command -v tmux >/dev/null 2>&1; then
  _AGENT_IN_TMUX="1"
else
  echo "[agent] WARNING: agent-shell auto-exec requires tmux. Running outside tmux will disable automatic command execution." >&2
fi



# ═══════════════════════════════════════════════════════════════════
# PIPELINE 1: [node] Prompt Prefix — implementation lives below in the
# "PIPELINE 1+3: Prompt Rendering" section (promptsubst + PROMPT). This block
# only declares the credential state that pipeline depends on.
# State: PROMPT, CREDENTIAL, _AGENT_BASE_PROMPT, promptsubst
# ═══════════════════════════════════════════════════════════════════

# ─── Credential State ─────────────────────────────────────────────────────────────────
CREDENTIAL=""
AGENT_PAUSED=""

# ─── Prerequisite Check ─────────────────────────────────────────────────────────────
# fail-fast: errors on missing deps and blocks source
_agent_check_deps() {
  local missing=()
  command -v bun >/dev/null 2>&1 || missing+=("bun (https://bun.sh)")
  command -v jq >/dev/null 2>&1 || missing+=("jq (brew install jq)")

  if [[ ${#missing} -gt 0 ]]; then
    echo "[agent] missing dependencies:" >&2
    for m in "${missing[@]}"; do
      echo "  - $m" >&2
    done
    return 1
  fi

  if [[ -z "${AGENT_HEADLESS:-}" && -z "${AGENT_API_KEY:-}" ]]; then
    echo "[agent] warning: AGENT_API_KEY not set. Set it before credential claim." >&2
    echo "  export AGENT_API_KEY=sk-..." >&2
  fi
  return 0
}

_agent_check_deps || return 1

# ─── Persistent Infrastructure ─────────────────────────────────────────────────

_agent_init_infra() {
  # Runtime temp lives OUTSIDE the repo: a FIFO inside the project tree hangs
  # `grep -r`/`rg`/`find` when they walk the tree and block reading the pipe.
  # Per-shell dir keyed by PID; removed on exit (TRAPEXIT).
  _AGENT_TMP_DIR="${TMPDIR:-/tmp}/agsh-$$"
  mkdir -p "$_AGENT_TMP_DIR" 2>/dev/null

  # Headless: no internal loop → no FIFOs / poll loop / zle -F machinery.
  if [[ -z "${AGENT_HEADLESS:-}" ]]; then
    _AGENT_POLL_FIFO="$_AGENT_TMP_DIR/agent_poll_fifo_$$"
    rm -f "$_AGENT_POLL_FIFO" 2>/dev/null
    mkfifo "$_AGENT_POLL_FIFO" 2>/dev/null || return 1
    exec {_AGENT_POLL_FD}<>"$_AGENT_POLL_FIFO"
    zle -F "$_AGENT_POLL_FD" _agent_poll_handler

    # --- State FIFO ---
    AGENT_FIFO_STATE="$_AGENT_TMP_DIR/agent_fifo_$$_state"
    rm -f "$AGENT_FIFO_STATE" 2>/dev/null
    mkfifo "$AGENT_FIFO_STATE" 2>/dev/null || return 1
    exec {AGENT_FIFO_FD}<>"$AGENT_FIFO_STATE"
    zle -F -w "$AGENT_FIFO_FD" _agent_async_handler
    setopt no_notify no_monitor
    { while true; do sleep "${AGENT_POLL_INTERVAL:-0.1}"; echo x > "$_AGENT_POLL_FIFO" 2>/dev/null; done } &
    _AGENT_POLL_PID=$!
    # idle state — icon rendering belongs to plug layer
    AGENT_STATUS='{"state":"idle"}'
  fi
}


# ═══════════════════════════════════════════════════════════════════
# PLUG LIFECYCLE
# ═══════════════════════════════════════════════════════════════════
_AGENT_LOADED_PLUGS=()

_agent_parse_plug_segment() {
  local file="$1" mode="$2"
  [[ -f "$file" ]] || { echo "[agent] plug file not found: $file" >&2; return 1; }
  grep -q "^# @register" "$file" || { echo "[agent] plug error: missing # @register in $file" >&2; return 1; }
  grep -q "^# @unregister" "$file" || { echo "[agent] plug error: missing # @unregister in $file" >&2; return 1; }
  case "$mode" in
    register) sed -n "/^# @register/,/^# @unregister/{/^# @register/d;/^# @unregister/d;p;}" "$file" ;;
    unregister) sed -n "/^# @unregister/,\$p" "$file" | grep -v "^# @unregister" ;;
  esac
}

_agent_source_plug_segment() {
  local file="$1" mode="$2" segment
  segment="$(_agent_parse_plug_segment "$file" "$mode")" || return 1
  [[ -z "$segment" ]] && return 0
  mkdir -p "${_AGENT_TMP_DIR:-${TMPDIR:-/tmp}/agsh-$$}" 2>/dev/null
  local tmpfile="${_AGENT_TMP_DIR:-${TMPDIR:-/tmp}/agsh-$$}/agsh_plug_$$.zsh"
  printf "%s\n" "$segment" > "$tmpfile"
  if ! source "$tmpfile"; then
    echo "[agent] plug $mode error in $file" >&2
    rm -f "$tmpfile"
    return 1
  fi
  rm -f "$tmpfile"
  return 0
}

_agent_get_plug_chain() {
  local cred="$1"
  _agent_cli_ready || return 1
  _agent_bun_cli prefix-chain --cred "$cred" --type plug --paths 2>/dev/null
}

_agent_source_plug_chain() {
  local cred="$1" paths p
  paths="$(_agent_get_plug_chain "$cred" 2>/dev/null)" || return 0
  [[ -z "$paths" ]] && return 0
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    _agent_source_plug_segment "$p" register && _AGENT_LOADED_PLUGS+=("$p")
  done <<< "$paths"
}

_agent_unload_plug_chain() {
  if (( ${#_AGENT_LOADED_PLUGS} == 0 )); then return 0; fi
  local i
  for (( i = ${#_AGENT_LOADED_PLUGS}; i > 0; i-- )); do
    _agent_source_plug_segment "${_AGENT_LOADED_PLUGS[i]}" unregister
  done
  _AGENT_LOADED_PLUGS=()
}

_agent_switch_plugs() {
  local old="$1" new="$2" old_paths new_paths p
  old_paths="$(_agent_get_plug_chain "$old" 2>/dev/null)" || old_paths=""
  new_paths="$(_agent_get_plug_chain "$new" 2>/dev/null)" || new_paths=""

  local old_only=()
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    if ! echo "$new_paths" | grep -qF "$p" 2>/dev/null; then
      old_only+=("$p")
    fi
  done <<< "$old_paths"

  local new_only=()
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    if ! echo "$old_paths" | grep -qF "$p" 2>/dev/null; then
      new_only+=("$p")
    fi
  done <<< "$new_paths"

  local i
  for (( i = ${#old_only}; i > 0; i-- )); do
    _agent_source_plug_segment "${old_only[i]}" unregister
  done
  local new_loaded=()
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    new_loaded+=("$p")
  done <<< "$new_paths"
  _AGENT_LOADED_PLUGS=("${new_loaded[@]}")

  for p in "${new_only[@]}"; do
    [[ -z "$p" ]] && continue
    _agent_source_plug_segment "$p" register && _AGENT_LOADED_PLUGS+=("$p")
  done
}


# _validate_credential: Delegates to TypeScript CLI for 5-layer validation.
_validate_credential() {
  _agent_bun_cli credential validate "$1"
}


# ─── Credential Shell Command ────────────────────────────────────────────────────
# credential(): Standard shell function — works in scripts, pipes, and interactively.
# Sets/unset CREDENTIAL env var; agent lifecycle managed by precmd hook.
#
# Usage: credential claim <id> — export CREDENTIAL=<id>, start agent via precmd
#       credential drop        — unset CREDENTIAL, stop agent via precmd
#       credential help        — show help

# Credential text slots: the kernel's own default implementations (English).
# credential() calls `_agent_credential_help` / `_agent_credential_status`;
# a later definition of either name replaces this one.
_agent_credential_help() {
  echo "Usage:" >&2
  echo "  credential claim <id>   - Claim a credential, load its plugs, start the agent" >&2
  echo "  credential drop         - Unset the CREDENTIAL env, stop the agent" >&2
  echo "  credential help         - Show this help" >&2
  echo "  credential              - Show this help" >&2
}

_agent_credential_status() {
  case "$1" in
    set)     echo "[credential] CREDENTIAL set to: ${CREDENTIAL}" >&2 ;;
    cleared) echo "[credential] CREDENTIAL cleared" >&2 ;;
  esac
}

credential() {
  local sub="${1:-help}"
  case "$sub" in
    claim)
      local id="${2:-}"
      if [[ -z "$id" ]]; then
        echo "Usage: credential claim <id>" >&2
        return 1
      fi
      _validate_credential "$id" || return 1
      local old="${CREDENTIAL:-}"
      if [[ -n "$old" && "$old" != "$id" ]]; then
        rm -f "$AGENT_NODES_PATH/$old/.lock"
      fi
      # Set CREDENTIAL before loading plugs (so @register sees correct cred)
      export CREDENTIAL="$id"
      echo $$ > "$AGENT_NODES_PATH/$id/.lock"
      if [[ -n "$old" && "$old" != "$id" ]]; then
        _agent_switch_plugs "$old" "$id"
        _agent_credential_status set
      elif [[ -z "$old" ]]; then
        _agent_source_plug_chain "$id"
        _agent_credential_status set
      fi
      ;;
    drop)
      _agent_unload_plug_chain
      [[ -n "$CREDENTIAL" ]] && rm -f "$AGENT_NODES_PATH/$CREDENTIAL/.lock"
      CREDENTIAL=""
      _agent_credential_status cleared
      ;;
    help|--help|-h)
      _agent_credential_help
      ;;
    *)
      echo "credential: unknown subcommand: $sub" >&2
      echo "Usage: credential {claim|drop|help}" >&2
      return 1
      ;;
  esac
}

# ─── Keybinding Handlers ───────────────────────────────────────────────────────────────
# toggle-pause: Ctrl+G toggle pause/resume
_toggle_pause() {
  if [[ -z "$CREDENTIAL" ]]; then
    # Not in agent loop — ignore
    return 0
  fi
  
  if [[ -n "$AGENT_PAUSED" ]]; then
    # Resume — restart the agent cycle
    AGENT_PAUSED=""
    _agent_wake
    echo "[agent] Resumed" >&2
  else
    AGENT_PAUSED="1"
    AGENT_STATUS='{"state":"paused"}'
    # Also cancel any pending exec
    [[ -n "$_AGENT_PENDING_CMD" ]] && {
        _AGENT_PENDING_CMD=""
        _AGENT_EXEC_TOOL_ID=""
        _agent_clear_timeout
        POSTDISPLAY=""
        _agent_render
    }
    echo "[agent] Paused (Ctrl+G to resume)" >&2
  fi
  
  return 0
}

# retry-api: Ctrl+T retry last API request with current CONTEXT
_retry_api() {
  if [[ -z "$CREDENTIAL" ]]; then
    return 0
  fi
  # Kill stuck API process if running, let precmd start fresh cycle
  if [[ -n "${AGENT_API_PID:-}" ]] && kill -0 "$AGENT_API_PID" 2>/dev/null; then
    _agent_debug_log "[agent] Killing stuck API ($AGENT_API_PID)..."
    kill "$AGENT_API_PID" 2>/dev/null
    AGENT_API_PID=""
    _agent_unlock
  fi
  if [[ -n "${_AGENT_PENDING_CMD:-}" ]]; then
    return 0
  fi
  _agent_debug_log "[agent] Retrying API request..."
  _agent_wake
}

# ═══════════════════════════════════════════════════════════════════
# PIPELINE 2: Command Execution Rendering
# State: BUFFER, POSTDISPLAY, _AGENT_EXEC_TOOL_ID
# Widgets: _agent_accept_line (defined in the ZLE Widget section below)
# ═══════════════════════════════════════════════════════════════════

# ─── Bridge: Single Rendering Entry Point ──────────────────────────────────────
# Core maintains only the state truth AGENT_STATUS; RPROMPT rendering belongs to the plug layer (promptsubst stays enabled by core)
# Central prompt rendering. Also triggered by accept-line exec path → precmd pipeline.
# Cached prompt: ${CREDENTIAL:-none} stays a literal — promptsubst expands it on each render; %# left for zsh.
_agent_render() {
  local _saved="$PROMPT"
  PROMPT="${_AGENT_CACHED_PROMPT:-$PROMPT}"
  zle reset-prompt
  PROMPT="$_saved"
}


# ─── Suggestion Apply Widgets ───────────────────────────────────────────────
# _agent_apply_suggestion: copy the pending agent command into the edit buffer
# and clear the pending state. Safe to call from a widget context.
_agent_apply_suggestion() {
    if [[ -n "${_AGENT_PENDING_CMD:-}" && -z "$BUFFER" ]]; then
        BUFFER="$_AGENT_PENDING_CMD"
        CURSOR=${#BUFFER}
        _AGENT_PENDING_CMD=""
        POSTDISPLAY=""
        _agent_clear_timeout
        _agent_render
    fi
}

# _agent_render_suggestion: display pending agent suggestion as POSTDISPLAY
# Used by async_handler and zle-line-init to show the pending command.
_agent_render_suggestion() {
    if [[ -n "${_AGENT_PENDING_CMD:-}" && -z "$POSTDISPLAY" && -z "$BUFFER" ]]; then
        POSTDISPLAY="$_AGENT_PENDING_CMD"
        zle -R
    fi
}

_agent_accept_suggestion_tab() {
    if [[ -n "${_AGENT_PENDING_CMD:-}" && -z "$BUFFER" ]]; then
        _agent_apply_suggestion
    else
        zle expand-or-complete
    fi
}

_agent_accept_suggestion_forward() {
    if [[ -n "${_AGENT_PENDING_CMD:-}" && -z "$BUFFER" ]]; then
        _agent_apply_suggestion
    else
        zle forward-char
    fi
}

_agent_zle_line_init() {
    _agent_render_suggestion
}



# ─── ZLE Widget ───────────────────────────────────────────────────────────────
# _agent_accept_line: Handles exec mode acceptance/cancellation, chat routing, pass-through
# Replaces default accept-line via zle -N accept-line.
_agent_accept_line() {
    local buf="$BUFFER"

    # Grey phase: user pressed Enter while POSTDISPLAY is shown, do nothing
    if [[ -z "$buf" && -n "${_AGENT_PENDING_CMD:-}" ]]; then
        return
    fi

    # User typed their own command during grey window: cancel pending state
    if [[ -n "$buf" && -n "${_AGENT_PENDING_CMD:-}" ]]; then
        _agent_clear_timeout
        POSTDISPLAY=""
        _AGENT_PENDING_CMD=""
        _AGENT_EXEC_TOOL_ID=""
        [[ -n "${_AGENT_ARTIFACT_DIR:-}" ]] && rm -rf "$_AGENT_ARTIFACT_DIR"
        _AGENT_ARTIFACT_DIR=""
        # fall through to execute BUFFER
    fi

    # Tool call: BUFFER was populated by timeout_handler, execute with capture
    if [[ -n "$buf" && -n "${_AGENT_EXEC_TOOL_ID:-}" ]]; then
        _AGENT_CAPTURE=1
        _AGENT_CAPTURE_CRED_BEFORE="${CREDENTIAL:-}"
        zle .accept-line
        return
    fi

    zle .accept-line
}



# ─── Register Widgets and Keybindings ─────────────────────────────────────────────────────
# Headless: the terminal is a plain shell driven externally — don't replace
# accept-line or bind agent keys.
if [[ -z "${AGENT_HEADLESS:-}" ]]; then
zle -N toggle-pause _toggle_pause
zle -N retry-api _retry_api
zle -N accept-line _agent_accept_line
zle -N zle-line-init _agent_zle_line_init

# Tab/Right accept the pending suggestion, else fall back to default behavior
bindkey '^G' toggle-pause

bindkey '^T' retry-api

bindkey '\t' _agent_accept_suggestion_tab

bindkey '^[[C' _agent_accept_suggestion_forward

zle -N _agent_timeout_handler
zle -N _agent_async_handler
zle -N _agent_accept_suggestion_tab
zle -N _agent_accept_suggestion_forward
fi


# ─── Export New Functions ─────────────────────────────────────────────────────────────
export -f _validate_credential credential \
         _toggle_pause _retry_api >/dev/null 2>&1 || true
export -f _agent_async_handler _agent_reset_cycle >/dev/null 2>&1 || true

# ─── Agent Cycle Lock ────────────────────────────────────────────────────────
# _agent_lock: Prevent precmd from starting new cycles while agent is working.
_agent_lock() { _AGENT_LOCKED="1"; }
# _agent_unlock: Allow precmd to start next cycle.
_agent_unlock() { _AGENT_LOCKED=""; }

# ─── Debug Log ─────────────────────────────────────────────────────────
# _agent_debug_log: append timestamped message to debug log.
# Only writes when AGENT_DEBUG is true. Safe to call unconditionally.
_agent_debug_log() {
  [[ "$AGENT_DEBUG" != "true" ]] && return
  [[ -z "${_AGENT_DEBUG_LOG:-}" ]] && _AGENT_DEBUG_LOG="${TMPDIR:-/tmp}/agent_debug_${CREDENTIAL:-global}.log"
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >> "$_AGENT_DEBUG_LOG"
}

# ─── Wake Helper ───────────────────────────────────────────────────────────
# Triggers precmd via accept-line when BUFFER is empty. Safe to call from
# zle -F handlers and keybinding widgets without interfering with user input.
_agent_wake() {
    [[ -z "$BUFFER" ]] && zle accept-line
}

_agent_preexec() {
    if [[ -n "${_AGENT_CAPTURE:-}" ]]; then
        exec 3>&1 4>&2
        exec > >(tee "$_AGENT_ARTIFACT_DIR/output") 2>&1
        _agent_start_exec_timeout
    fi
}
preexec_functions+=(_agent_preexec)



# ─── precmd Hook ───────────────────────────────────────────────────────────
# Runs on every prompt: checks state, starts/continues the agent cycle.
_agent_precmd() {
    local _cmd_exit=$?      # MUST be first — capture exit code before any command runs
    _AGENT_CACHED_PROMPT='%F{cyan}[${CREDENTIAL:-none}]%f '"${_AGENT_BASE_PROMPT}"

    # ── Collect output from agent-initiated accept-line command ──
    if [[ -n "${_AGENT_CAPTURE:-}" ]]; then
        exec >&3 2>&4
        exec 3>&- 4>&-

        _agent_clear_exec_timeout
        local _capfile="$_AGENT_ARTIFACT_DIR/output"
        local _output="$(cat "$_capfile" 2>/dev/null)"
        local _tid="${_AGENT_EXEC_TOOL_ID:-}"
        local _cred_before="${_AGENT_CAPTURE_CRED_BEFORE:-}"

        [[ -n "${AGENT_OUTPUT_MAX_LENGTH:-}" && ${#_output} -gt $AGENT_OUTPUT_MAX_LENGTH ]] && \
            _output="${_output:0:$AGENT_OUTPUT_MAX_LENGTH}[truncated]"

        local _msg="Exit code: $_cmd_exit"
        [[ -n "$_output" ]] && _msg="Exit code: $_cmd_exit
Output:
$_output"

        _record_tool_result "$_tid" "$_msg" "${_cred_before:-}"

        _AGENT_CAPTURE=""
        _AGENT_CAPTURE_CRED_BEFORE=""
        [[ -n "${_AGENT_ARTIFACT_DIR:-}" ]] && rm -rf "$_AGENT_ARTIFACT_DIR"
        _AGENT_ARTIFACT_DIR=""
        _AGENT_EXEC_TOOL_ID=""
    fi

    # ── Headless mode: the loop is driven externally. The tail-call
    #    above already wrote the tool result to history; no loop, no render. ──
    if [[ -n "${AGENT_HEADLESS:-}" ]]; then
        AGENT_IN_PRECMD=0
        return
    fi
    AGENT_STATUS='{"state":"idle"}'

    if [[ -n "$AGENT_PAUSED" ]]; then
    AGENT_STATUS='{"state":"paused"}'
    AGENT_IN_PRECMD=0; return
    fi

    if [[ -z "$_AGENT_LOCKED" && -z "${_AGENT_PENDING_CMD:-}" ]]; then
        if [[ -n "${CREDENTIAL:-}" ]]; then
            local next_tool="$(_detect_next_pending_tool)"
            if [[ -n "$next_tool" && "$next_tool" != "null" ]]; then
                local tool_id="$(printf '%s' "$next_tool" | jq -r '.id')"
                local cmd="$(printf '%s' "$next_tool" | jq -r '.function.arguments | fromjson | .cmd' 2>/dev/null)"
                local func_name="$(printf '%s' "$next_tool" | jq -r '.function.name')"

                _agent_accept_tool_call "$tool_id" "$cmd" "$func_name"
            else
                AGENT_STATUS='{"state":"streaming"}'
                _agent_lock
                _start_api_call
            fi
        fi
    fi

    AGENT_IN_PRECMD=0
}
precmd_functions+=(_agent_precmd)

# ─── History-based Tool Detection ────────────────────────────────────────────────
# _detect_next_pending_tool: Scan history JSONL for assistant tool_calls
# that have no corresponding tool result message.
_detect_next_pending_tool() {
  _agent_cli_ready || { echo ""; return; }
  _agent_bun_cli context detect-pending --cred "$CREDENTIAL" 2>/dev/null
}



# ─── API Call Launcher ────────────────────────────────────────────────────────────
# _start_api_call: start src/cli.ts stream in background, pipe SSE events to state FIFO.
# SSE events: token→streaming, tool_calls→accumulate, done→api_done(with data), error→error.
# TS stream reads history directly via buildContext().
_start_api_call() {
  _agent_cli_ready || { return 1; }

  [[ "$AGENT_DEBUG" == "true" ]] && _agent_debug_log "start_api_call: cred=$CREDENTIAL"
  {
    _agent_bun_cli stream --cred "$CREDENTIAL" --nodes-path "$AGENT_NODES_PATH" 2>/dev/null | \
    while IFS= read -r line; do
      [[ "$line" =~ ^data:\ (.*) ]] || continue
      # NOTE: in a zsh pipeline subshell, a standalone `local X` declaration
      # with assignment deferred to a later command substitution emits ghost
      # output (X=<value> leaks to stdout → pollutes the FIFO). Declare with
      # assignment in one statement only.
      local event="${match[1]}" etype="$(printf '%s' "${match[1]}" | jq -r '.type' 2>/dev/null)"

      case "$etype" in
        progress|token)
          local tokens="" speed="" reasoning=""
          read -r tokens speed reasoning < <(printf '%s' "$event" | jq -r '[(.tokens // .estimatedTokens // 0), (.speed // 0), (.reasoning // .completionTokens // 0)] | @tsv' 2>/dev/null)
          printf '{"state":"streaming","tokens":%s,"speed":%s,"reasoning":%s}\n' "$tokens" "$speed" "$reasoning"
          ;;

        done)
          # TS already wrote history; just relay compact state to FIFO
          printf '%s' "$event" | jq -c '{state:"api_done",tokens:0} + .'
          ;;

        error)
          printf '{"state":"error","tokens":0}\n'
          ;;

        fatal)
          local errmsg="$(printf '%s' "$event" | jq -r '.error // "internal error"')"
          printf '{"state":"fatal","tokens":0,"message":"%s"}\n' "$errmsg"
          ;;
      esac
    done >&$AGENT_FIFO_FD
  } &
  AGENT_API_PID=$!
}

# ─── Auto-Exec Timeout ───────────────────────────────────────────────────────────
# Uses a temp FIFO + zle -F to trigger auto-exec after AGENT_EXEC_DELAY seconds.
_agent_start_timeout() {
  _agent_clear_timeout
  mkdir -p "$_AGENT_TMP_DIR" 2>/dev/null
  local _tf="$_AGENT_TMP_DIR/agent_timeout_fifo_$$"
  rm -f "$_tf" 2>/dev/null
  mkfifo "$_tf" 2>/dev/null || return
  exec {_AGENT_TIMEOUT_FD}<>"$_tf"
  zle -F -w "$_AGENT_TIMEOUT_FD" _agent_timeout_handler
  ( sleep "${AGENT_EXEC_DELAY:-2}"; echo x > "$_tf" ) &
  _AGENT_TIMEOUT_PID=$!
}

_agent_clear_timeout() {
  [[ -n "${_AGENT_TIMEOUT_FD:-}" ]] && zle -F "${_AGENT_TIMEOUT_FD}" 2>/dev/null
  [[ -n "${_AGENT_TIMEOUT_FD:-}" ]] && exec {_AGENT_TIMEOUT_FD}<&- 2>/dev/null
  [[ -n "${_AGENT_TIMEOUT_PID:-}" ]] && kill "$_AGENT_TIMEOUT_PID" 2>/dev/null
  _AGENT_TIMEOUT_PID=""
  _AGENT_TIMEOUT_FD=""
  [[ -n "${_AGENT_TMP_DIR:-}" ]] && rm -f "$_AGENT_TMP_DIR/agent_timeout_fifo_$$" 2>/dev/null
}

_agent_timeout_handler() {
  local _
  read -r _ <&$_AGENT_TIMEOUT_FD 2>/dev/null
  _agent_clear_timeout

  if [[ -n "${AGENT_PAUSED:-}" ]]; then
    return
  fi

  if [[ -n "$BUFFER" && -n "${_AGENT_PENDING_CMD:-}" ]]; then
    # User typed during the grey window: cancel the pending agent command.
    _AGENT_PENDING_CMD=""
    _AGENT_EXEC_TOOL_ID=""
    POSTDISPLAY=""
    _agent_render
    return
  fi

  if [[ -z "$BUFFER" && -n "${_AGENT_PENDING_CMD:-}" ]]; then
    # Apply pending command (tool call or agent response). Move it into BUFFER,
    # clear POSTDISPLAY, then inject Enter via tmux. _agent_accept_line
    # routes execution based on _AGENT_EXEC_TOOL_ID.
    BUFFER="$_AGENT_PENDING_CMD"
    CURSOR=${#BUFFER}
    _AGENT_PENDING_CMD=""
    POSTDISPLAY=""
    _agent_render

    if [[ -n "${_AGENT_IN_TMUX:-}" ]]; then
      ( sleep 0.1; tmux send-keys -t "$TMUX_PANE" Enter ) &
    else
      # No tmux: clear pending state so the prompt is clean.
      _AGENT_PENDING_CMD=""
      _AGENT_EXEC_TOOL_ID=""
      _agent_render
    fi
  fi
}

# ─── Execution Timeout ──────────────────────────────────────────────────────────
# Watches the captured command: after AGENT_EXEC_TIMEOUT seconds, tmux send-keys
# C-c cancels it — same path as a manual interrupt (exit 130). Timeout and manual
# interrupt are deliberately indistinguishable; both surface as "Exit code:".
_agent_start_exec_timeout() {
    _agent_clear_exec_timeout
    (( ${AGENT_EXEC_TIMEOUT:-0} > 0 )) || return
    [[ -n "${_AGENT_IN_TMUX:-}" ]] || return
    ( sleep "$AGENT_EXEC_TIMEOUT"; tmux send-keys -t "$TMUX_PANE" C-c ) &
    _AGENT_EXEC_TIMEOUT_PID=$!
}

_agent_clear_exec_timeout() {
    [[ -n "${_AGENT_EXEC_TIMEOUT_PID:-}" ]] && kill "$_AGENT_EXEC_TIMEOUT_PID" 2>/dev/null
    _AGENT_EXEC_TIMEOUT_PID=""
}


# ─── zle -F Event Handler ────────────────────────────────────────────────────────
# _agent_async_handler: zle -F callback invoked when background API writes to state FIFO
# State truth is FIFO-driven: each line read from the state FIFO is stored wholesale into AGENT_STATUS
#
# Usage: (called by zle -F automatically)
_agent_async_handler() {
  local state
  AGENT_IN_HANDLER=1
  if ! read -r state <&$AGENT_FIFO_FD 2>/dev/null; then
    # API process exited or FIFO closed unexpectedly.
    # Clean up FIFOs, unregister zle-F, refresh display.
    _agent_reset_cycle
    AGENT_IN_HANDLER=0
    return
  fi

  # Guard: zle -F can fire spuriously after zle reset-prompt, yielding an empty
  # read. Skip it rather than blank AGENT_STATUS with an empty state.
  if [[ -z "$state" ]]; then
    AGENT_IN_HANDLER=0
    return
  fi
  local s tokens content speed reasoning message
  read -r s tokens speed reasoning message < <(jq -r '[.state // "unknown", .tokens // 0, .speed // 0, .reasoning // 0, .message // ""] | @tsv' <<< "$state" 2>/dev/null)
  # Store the whole state JSON line into AGENT_STATUS verbatim — core does no
  # transformation here; rendering/presentation is the plug layer's concern
  # (see the PIPELINE notes).
  AGENT_STATUS="$state"

  [[ "$AGENT_DEBUG" == "true" ]] && _agent_debug_log "HANDLER state=$s tokens=$tokens reasoning=$reasoning"

  case "$s" in
    streaming)
      # streaming: AGENT_STATUS (set above) already carries live tokens/speed/reasoning relayed from plug events
      ;;


    error)
      # no AGENT_STATUS mutation here — surfacing is plug layer's concern
      BUFFER=""; POSTDISPLAY=""
      _agent_unlock
      ;;

    fatal)
      # Internal error (e.g., prefix chain topology corruption)
      AGENT_API_PID=""
      BUFFER=""; POSTDISPLAY=""
      _agent_clear_timeout
      _agent_clear_exec_timeout
      _agent_unlock
      ;;

    api_done)
      AGENT_API_PID=""

      # History already written by TS stream command.
      # Next: surface content or first tool call as a POSTDISPLAY suggestion.
      local _content _has_tc
      _content="$(jq -r '.content // ""' <<< "$state")"
      _has_tc="$(jq -r '.tool_calls != null' <<< "$state")"

      # POSTDISPLAY: content -> "agent response", tool-only -> first tool cmd
      if [[ -z "$AGENT_PAUSED" ]]; then
        if [[ -n "$_content" ]]; then
          _agent_accept_tool_call "" "agent response" "shell"
        elif [[ "$_has_tc" == "true" ]]; then
          local _tool_id _cmd _func_name
          _tool_id="$(jq -r '.tool_calls[0].id // empty' <<< "$state")"
          _cmd="$(jq -r '.tool_calls[0].function.arguments | fromjson | .cmd // empty' <<< "$state")"
          _func_name="$(jq -r '.tool_calls[0].function.name // empty' <<< "$state")"

          _agent_accept_tool_call "$_tool_id" "$_cmd" "$_func_name"
        fi
        _agent_unlock
        _agent_render_suggestion
      fi
      ;;

  esac
  AGENT_IN_HANDLER=0
}

# ═══════════════════════════════════════════════════════════════════
# PIPELINE 3: Poll Handler — drives idle state and render refresh
# ═══════════════════════════════════════════════════════════════════

# ─── Poll Handler ────────────────────────────────────────────────────────────────
_agent_poll_handler() {
  local _p
  read -r _p <&$_AGENT_POLL_FD 2>/dev/null || return
  [[ "${AGENT_IN_HANDLER:-0}" == "1" ]] && return
  if [[ -z "${CREDENTIAL:-}" ]]; then
    AGENT_STATUS='{"state":"idle"}'
  fi
  _agent_render
}

# _agent_reset_cycle: Kill old API process and clear per-cycle state.
# Does NOT touch infrastructure (FIFO, fd, handler). Safe to call anytime.
_agent_reset_cycle() {
  [[ -n "${AGENT_API_PID:-}" ]] && kill -0 "$AGENT_API_PID" 2>/dev/null && kill "$AGENT_API_PID" 2>/dev/null
  AGENT_API_PID=""
  _agent_clear_timeout
  _agent_clear_exec_timeout
  _agent_unlock
  _AGENT_EXEC_TOOL_ID=""
}

# ─── Agent Main Loop ───────────────────────────────────────────────────────────────

# _agent_accept_tool_call: validate one tool call and set up its execution
# state (source-agnostic). Shared by two trigger paths — precmd
# detect-pending and async_handler api_done — which each parse the JSON and
# call in with their (tool_id, cmd, func_name) triple.
# Usage: _agent_accept_tool_call <tool_call_id> <cmd> <func_name>
_agent_accept_tool_call() {
  local tool_id="$1" cmd="$2" func_name="$3"
  if [[ "$func_name" != "shell" ]]; then
    _record_tool_result "$tool_id" "Error: unknown tool: $func_name"
  elif [[ -z "$cmd" ]]; then
    _record_tool_result "$tool_id" "Error: no cmd in shell tool arguments"
  else
    # Empty tool_id = agent response (plain text): no capture dir needed. Non-empty = a real tool call: an artifact dir holds the command output
    [[ -n "$tool_id" ]] && _AGENT_ARTIFACT_DIR="$(mktemp -d)"
    _AGENT_PENDING_CMD="$cmd"
    _AGENT_EXEC_TOOL_ID="$tool_id"
    _agent_start_timeout
  fi
}

# _record_tool_result: Writes a tool result directly to history JSONL.
# Tool results append to history JSONL; no shell-side context cache.
# Usage: _record_tool_result <tool_call_id> <content> [credential]
_record_tool_result() {
  local _cred="${3:-${CREDENTIAL:-}}"
  [[ -z "$_cred" ]] && return
  _agent_cli_ready || return
  # The transfer file must use an absolute path: the persistent terminal's
  # cwd can be moved away (even into a deleted directory), so a relative path
  # would fail the write and stall the external poll.
  local _content_file="${TMPDIR:-/tmp}/agent_tool_$$.txt"
  printf '%s' "$2" > "$_content_file"
  _agent_bun_cli context record-tool \
    --cred "$_cred" \
    --nodes-path "$AGENT_NODES_PATH" \
    --id "$1" \
    --content-file "$_content_file" >/dev/null 2>/dev/null
  rm -f "$_content_file"
}

# ═══════════════════════════════════════════════════════════════════
# PIPELINE 1+3: Prompt Rendering
# P1: PROMPT with [node] prefix via ${CREDENTIAL:-none}
# P3: RPROMPT content is produced by the plug layer — core only writes AGENT_STATUS, enables promptsubst, and triggers re-renders (zle reset-prompt); it never assigns the RPROMPT variable itself
# ═══════════════════════════════════════════════════════════════════

# ─── Prompt Enhancement ──────────────────────────────────────────────────────
# Embed credential prefix into PROMPT via promptsubst.
# Each time the prompt renders, ${CREDENTIAL:-none} expands to the
# current credential id (or "none"), shown in cyan before the user's prompt.
# promptsubst expands it per render — no precmd hook.
_AGENT_BASE_PROMPT="${PROMPT:-%# }"
setopt promptsubst 2>/dev/null
PROMPT='%F{cyan}[${CREDENTIAL:-none}]%f '"${_AGENT_BASE_PROMPT}"
_AGENT_CACHED_PROMPT='%F{cyan}[${CREDENTIAL:-none}]%f '"${_AGENT_BASE_PROMPT}"


# --- startup banner -----------------------------------------------------------
_agent_banner() {
  local v
  v="$(_agent_bun_cli --version 2>/dev/null)" || v="dev"
  echo "agent-shell ${v}"
  print -r -- "$_AGENT_BANNER_TEXT"
}

# _agent_exit_cleanup: best-effort teardown on shell exit (registered via
# trap ... EXIT). Shell exit bypasses `agent unload` (e.g. tmux kill-session,
# closing the terminal), so this hook is what prevents FIFO/dir leaks.
_agent_exit_cleanup() {
  [[ -n "${AGENT_API_PID:-}" ]] && kill "$AGENT_API_PID" 2>/dev/null
  [[ -n "${_AGENT_POLL_PID:-}" ]] && kill "$_AGENT_POLL_PID" 2>/dev/null
  [[ -n "${_AGENT_TIMEOUT_PID:-}" ]] && kill "$_AGENT_TIMEOUT_PID" 2>/dev/null
  [[ -n "${_AGENT_EXEC_TIMEOUT_PID:-}" ]] && kill "$_AGENT_EXEC_TIMEOUT_PID" 2>/dev/null
  [[ -n "${AGENT_FIFO_FD:-}" ]] && zle -F "${AGENT_FIFO_FD}" 2>/dev/null
  [[ -n "${_AGENT_POLL_FD:-}" ]] && zle -F "${_AGENT_POLL_FD}" 2>/dev/null
  [[ -n "${_AGENT_TIMEOUT_FD:-}" ]] && zle -F "${_AGENT_TIMEOUT_FD}" 2>/dev/null
  [[ -n "${AGENT_FIFO_FD:-}" ]] && exec {AGENT_FIFO_FD}<&- 2>/dev/null
  [[ -n "${_AGENT_POLL_FD:-}" ]] && exec {_AGENT_POLL_FD}<&- 2>/dev/null
  [[ -n "${_AGENT_TIMEOUT_FD:-}" ]] && exec {_AGENT_TIMEOUT_FD}<&- 2>/dev/null
  [[ -n "${_AGENT_TMP_DIR:-}" ]] && rm -rf "$_AGENT_TMP_DIR" 2>/dev/null
}

_agent_unload() {
  # 1. Kill API background process if running
  if [[ -n "${AGENT_API_PID:-}" ]] && kill -0 "$AGENT_API_PID" 2>/dev/null; then
    kill "$AGENT_API_PID" 2>/dev/null
  fi
  _agent_clear_timeout
  _agent_clear_exec_timeout

  # 2. Cleanup async infrastructure
  zle -F "${AGENT_FIFO_FD:-}" 2>/dev/null
  [[ -n "${AGENT_FIFO_FD:-}" ]] && exec {AGENT_FIFO_FD}<&- 2>/dev/null
  rm -f "${AGENT_FIFO_STATE:-}" 2>/dev/null

  # 3. Remove ZLE widgets
  zle -D toggle-pause 2>/dev/null
  zle -D retry-api 2>/dev/null

  # 4. Restore keybindings to zsh defaults
  zle -D accept-line 2>/dev/null
  bindkey -r '^G' 2>/dev/null
  bindkey -r '^T' 2>/dev/null

  # 5. Restore original prompt (if we have it)
  if [[ -n "${_AGENT_BASE_PROMPT:-}" ]]; then
    PROMPT="$_AGENT_BASE_PROMPT"
  fi
  # 6. Unset the state truth: on each promptsubst expansion the render
  #    plug's presence-test misses AGENT_STATUS and prints the saved RPROMPT
  #    text to restore the display (subshell prints only — no variable
  #    write-back, so the template stays as-is).
  unset AGENT_STATUS
  # 7. Clear POSTDISPLAY
  POSTDISPLAY=""

  # 8. Remove precmd hooks
  local new_precmd=()
  for fn in "${precmd_functions[@]}"; do
    [[ "$fn" == "_agent_precmd" ]] && continue
    new_precmd+=("$fn")
  done
  precmd_functions=("${new_precmd[@]}")

  # 9. Remove agent preexec hook
  local _new_hooks=()
  for _fn in "${preexec_functions[@]}"; do
    [[ "$_fn" == "_agent_preexec" ]] && continue
    _new_hooks+=("$_fn")
  done
  preexec_functions=("${_new_hooks[@]}")

  # 10. Remove lock files
  local lock_files=("$AGENT_NODES_PATH/"*/.lock(N))
  [[ ${#lock_files} -gt 0 ]] && rm -f "${lock_files[@]}"



  # 11. Unset all agent variables
  unset AGENT_FIFO_STATE AGENT_API_PID
  unset AGENT_FIFO_FD AGENT_PAUSED CREDENTIAL
  unset _AGENT_BASE_PROMPT _AGENT_CACHED_PROMPT _AGENT_BANNER_TEXT
  unset _AGENT_EXEC_TOOL_ID _AGENT_LOCKED _AGENT_ARTIFACT_DIR _AGENT_PENDING_CMD _AGENT_CAPTURE _AGENT_CAPTURE_CRED_BEFORE _AGENT_IN_TMUX
  unset _AGENT_TIMEOUT_FD _AGENT_TIMEOUT_PID _AGENT_EXEC_TIMEOUT_PID
  unset _AGENT_SOURCED

  # 12. Unfunction agent commands
  unfunction agent 2>/dev/null
  unfunction _agent_async_handler 2>/dev/null
  unfunction _agent_reset_cycle 2>/dev/null
  unfunction credential 2>/dev/null
  unfunction _toggle_pause 2>/dev/null
  unfunction _retry_api 2>/dev/null
  unfunction _agent_accept_line 2>/dev/null
  unfunction _agent_unload 2>/dev/null
  unfunction _start_api_call 2>/dev/null
  unfunction _agent_wake 2>/dev/null
  unfunction _agent_preexec 2>/dev/null
  unfunction _agent_help 2>/dev/null
  unfunction _agent_credential_help 2>/dev/null
  unfunction _agent_credential_status 2>/dev/null

  # 13. Clean up polling timer
  zle -F "${_AGENT_POLL_FD:-}" 2>/dev/null
  [[ -n "${_AGENT_POLL_FD:-}" ]] && exec {_AGENT_POLL_FD}<&- 2>/dev/null
  [[ -n "${_AGENT_POLL_PID:-}" ]] && kill "$_AGENT_POLL_PID" 2>/dev/null
  rm -f "${_AGENT_POLL_FIFO:-}" 2>/dev/null
  rm -rf "${_AGENT_TMP_DIR:-}" 2>/dev/null
  unset _AGENT_POLL_FD _AGENT_POLL_PID _AGENT_POLL_FIFO _AGENT_TMP_DIR

  _agent_debug_log "[agent] unloaded"
  [[ -f "${_AGENT_DEBUG_LOG:-}" ]] && rm -f "$_AGENT_DEBUG_LOG" 2>/dev/null
}

# ─── User and project config ─────────────────────────────────────────────────
# Sourced here, after every definition above, so that whatever the config
# defines takes effect before the banner prints (a slot resolves at call time).
# Loaded once per shell -- a re-source returns at the idempotency guard above.
[[ -f ~/.agshrc ]] && source ~/.agshrc
[[ -f .agshrc ]] && source .agshrc

# Make AGENT_NODES_PATH absolute only now: after the config above (a config may
# still set it, as before) and before any use -- the CLI subprocesses read the
# exported value.
[[ "$AGENT_NODES_PATH" != /* ]] && AGENT_NODES_PATH="$PWD/$AGENT_NODES_PATH"
export AGENT_NODES_PATH

_agent_banner
_agent_init_infra
trap _agent_exit_cleanup EXIT
# ─── Export Cycle Functions ─────────────────────────────────────────────────────────────
export -f _record_tool_result >/dev/null 2>&1 || true
