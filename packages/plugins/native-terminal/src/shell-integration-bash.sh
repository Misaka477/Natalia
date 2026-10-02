# Natalia shell integration for bash.
#
# Emits the OSC 133 command-lifecycle markers so a terminal can tell one command
# from the next. This is the FinalTerm-family common spelling, not a private
# namespace: any terminal that understands shell integration reads these, and
# nothing has to know Natalia is the reader.
#
# Injected with `bash --rcfile`, which is why sourcing the operator's own rc lives
# here rather than in the launcher: bash gives us either its rc or ours, never
# both.
#
# WHAT THE MARKERS MEAN, in stream order:
#   133;A   a prompt is being drawn
#   133;B   the command input is about to be accepted
#   633;E   the command line itself
#   133;C   the command's output begins
#   133;D   the command finished, exit code after the semicolon (absent = no
#           command ran: an empty prompt or an interrupt)
#
# WHY TWO NAMESPACES: 133 carries no field for the command text, and inventing a
# private sequence would be worse than reusing the one that already exists. So the
# lifecycle is the standard and the command line is 633's `E`, exactly as VSCode
# does it. A reader that only understands 133 still gets the lifecycle; only the
# command line is lost.

# Injecting twice would double the prompt markers, so a nested shell (a subshell
# from a command) must not reinstall the hooks.
if [ -n "${NATALIA_SHELL_INTEGRATION:-}" ]; then
	return 2>/dev/null || exit 0
fi
NATALIA_SHELL_INTEGRATION=1

# The launcher sets this to say "I gave you this file instead of ~/.bashrc, so run
# the real one yourself".
if [ "${NATALIA_INJECTION:-}" = "1" ]; then
	if [ -r "$HOME/.bashrc" ]; then
		. "$HOME/.bashrc"
	fi
	unset NATALIA_INJECTION
fi

# Escape a value for embedding in an OSC sequence: double backslashes, and turn
# every character that would terminate the sequence or be read as a field
# separator into its hex form. Without this, a command containing BEL ends the
# marker early and the rest of the command is read as raw output.
__natalia_escape() {
	local LC_ALL=C out="$1"
	out="${out//\\/\\\\}"
	out="${out//;/\\x3b}"
	out="${out//$'\a'/\\x07}"
	out="${out//$'\033'/\\x1b}"
	printf '%s' "$out"
}

# Continuation prompt: the model needs to know a PS2 means "still the same
# command", not "a new command started". 133 has no continuation marker, so the
# facts a reader needs are the bracketing of PS2 with something it can ignore.
__natalia_original_PS1="${PS1-}"
__natalia_original_PS2="${PS2-}"
__natalia_custom_PS1=""
__natalia_custom_PS2=""
__natalia_in_command=1
__natalia_command=""
__natalia_first_prompt=""

__natalia_prompt_start() { printf '\033]133;A\a'; }
__natalia_prompt_end() { printf '\033]133;B\a'; }
__natalia_continuation_start() { printf '\033]133;L\a'; }
__natalia_continuation_end() { printf '\033]133;M\a'; }

__natalia_command_output_start() {
	if [ -z "${__natalia_first_prompt:-}" ]; then
		return
	fi
	printf '\033]633;E;%s\a' "$(__natalia_escape "${__natalia_command}")"
	printf '\033]133;C\a'
}

__natalia_command_complete() {
	if [ -z "${__natalia_first_prompt:-}" ]; then
		__natalia_first_prompt=1
		return
	fi
	if [ -z "${__natalia_command:-}" ]; then
		# No command ran — an empty prompt or an interrupt. The exit code is
		# deliberately ABSENT rather than 0: a reader must not be able to
		# mistake "nothing happened" for "succeeded".
		printf '\033]133;D\a'
	else
		printf '\033]133;D;%s\a' "${__natalia_status}"
	fi
}

# Wrap the prompt once, and re-wrap if the operator changed PS1 after startup —
# otherwise their change would drop the markers silently, which is worse than the
# markers disappearing noisily at the next prompt.
__natalia_wrap_prompt() {
	if [ "$__natalia_in_command" != "1" ]; then return; fi
	if [ -z "$__natalia_custom_PS1" ] || [ "$__natalia_custom_PS1" != "$PS1" ]; then
		__natalia_original_PS1="$PS1"
		__natalia_custom_PS1="\[$(__natalia_prompt_start)\]${__natalia_original_PS1}\[$(__natalia_prompt_end)\]"
		PS1="$__natalia_custom_PS1"
	fi
	if [ -z "$__natalia_custom_PS2" ] || [ "$__natalia_custom_PS2" != "$PS2" ]; then
		__natalia_original_PS2="$PS2"
		__natalia_custom_PS2="\[$(__natalia_continuation_start)\]${__natalia_original_PS2}\[$(__natalia_continuation_end)\]"
		PS2="$__natalia_custom_PS2"
	fi
	__natalia_in_command=0
}

__natalia_precmd() {
	__natalia_status="$?"
	__natalia_command_complete
	__natalia_command=""
	__natalia_wrap_prompt
}

# preexec runs before each command, via a DEBUG trap. `history 1` gives the
# command as typed, which is what the model should see; BASH_COMMAND has aliases
# already expanded and is not what was written.
#
# THE EXIT CODE IS CAPTURED HERE, NOT IN PROMPT_COMMAND. A DEBUG trap fires before
# PROMPT_COMMAND runs, and the trap's own commands (`[[`, `history`, `sed`) all
# succeed — so by the time a prompt command reads `$?` it is 0 whatever the
# command did. Measured: `false` emitted `133;D;0`. The trap sees the real status
# because it is the first thing to run after the command.
__natalia_status=0
__natalia_preexec() {
	__natalia_status="$?"
	if [ "$__natalia_in_command" != "0" ]; then
		return "$__natalia_status"
	fi
	__natalia_in_command=1
	if [[ "$BASH_COMMAND" != __natalia_prompt* ]]; then
		__natalia_command="$(builtin history 1 | sed 's/^ *[0-9]* *//')"
	else
		__natalia_command=""
	fi
	__natalia_command_output_start
	return "$__natalia_status"
}

# A DEBUG trap already installed (starship, bash-preexec, a prompt framework)
# must keep working, so ours chains to it rather than replacing it.
__natalia_original_dbg_trap="$(trap -p DEBUG | sed -n "s/^trap -- '\(.*\)' DEBUG$/\1/p")"
if [ -n "$__natalia_original_dbg_trap" ]; then
	__natalia_preexec_chained() {
		__natalia_preexec
		eval "${__natalia_original_dbg_trap}"
	}
	trap '__natalia_preexec_chained' DEBUG
else
	trap '__natalia_preexec' DEBUG
fi

# PROMPT_COMMAND may already exist; ours runs after the operator's.
__natalia_original_prompt_command="${PROMPT_COMMAND:-}"
if [ -n "${__natalia_original_prompt_command:-}" ] &&
	[ "${__natalia_original_prompt_command:-}" != "__natalia_prompt_cmd" ]; then
	__natalia_prompt_cmd_original() {
		eval "${__natalia_original_prompt_command}"
		__natalia_precmd
	}
	PROMPT_COMMAND=__natalia_prompt_cmd_original
else
	__natalia_prompt_cmd() {
		__natalia_precmd
	}
	PROMPT_COMMAND=__natalia_prompt_cmd
fi

__natalia_wrap_prompt
