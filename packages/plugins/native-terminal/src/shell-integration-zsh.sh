# Natalia shell integration for zsh.
#
# Emits the OSC 133 command-lifecycle markers so a terminal can tell one command
# from the next. The FinalTerm-family common spelling, not a private namespace:
# any terminal that understands shell integration reads these, and nothing has to
# know Natalia is the reader.
#
# Injected with ZDOTDIR pointing at a directory holding this as .zshrc, which is
# how zsh takes a replacement rc — `--rcfile` is bash's flag and does not exist
# here. `NATALIA_INJECTION=1` says "source the operator's real .zshrc yourself".
#
# WHAT THE MARKERS MEAN, in stream order:
#   133;A   a prompt is being drawn
#   133;B   the command input is about to be accepted
#   633;E   the command line itself
#   133;C   the command's output begins
#   133;D   the command finished, exit code after the semicolon (absent = no
#           command ran: an empty prompt or an interrupt)
#
# WHY THE HOOKS DIFFER FROM BASH. zsh has no PROMPT_COMMAND and no usable DEBUG
# trap; it has `add-zsh-hook precmd/preexec`. So this is not a translation of the
# bash script — the bash version reads the command back out of `history 1` (a
# failing external command), while zsh's preexec HANDS the command over as $1.
# Better input, less to go wrong.
#
# WHY TWO NAMESPACES: 133 carries no field for the command text, and inventing a
# private sequence would be worse than reusing the one that already exists. So the
# lifecycle is the standard and the command line is 633's `E`, exactly as VSCode
# does it.

builtin autoload -Uz add-zsh-hook

if [ -n "${NATALIA_SHELL_INTEGRATION:-}" ]; then
	builtin return
fi
NATALIA_SHELL_INTEGRATION=1

# The operator's own rc, when we replaced it.
#
# NATALIA_USER_ZDOTDIR is where their rc REALLY lives. It must be captured before
# ZDOTDIR is pointed at our directory — sourcing "${ZDOTDIR:-$HOME}/.zshrc" with an
# already-overridden ZDOTDIR sources THIS loader again instead of the operator's
# rc, which is what the first version did and what the real-zsh run caught: the
# script loaded, its functions were defined, and not one marker appeared, because
# the real rc (and with it any prompt framework) never ran.
if [ "${NATALIA_INJECTION:-}" = "1" ]; then
	builtin local user_rc="${NATALIA_USER_ZDOTDIR:-$HOME}/.zshrc"
	if [ -r "$user_rc" ]; then
		builtin . "$user_rc"
	fi
	builtin unset NATALIA_INJECTION NATALIA_USER_ZDOTDIR
fi

# Escape a value for embedding in an OSC sequence: double backslashes, and turn
# every character that would terminate the sequence or be read as a field
# separator into its hex form.
__natalia_escape() {
	builtin local out="$1"
	out="${out//\\/\\\\}"
	out="${out//;/\\x3b}"
	out="${out//$'\a'/\\x07}"
	out="${out//$'\033'/\\x1b}"
	builtin printf '%s' "$out"
}

__natalia_in_command=""
__natalia_command=""
__natalia_first_prompt=""

__natalia_prompt_start() { builtin printf '\033]133;A\a'; }
__natalia_prompt_end() { builtin printf '\033]133;B\a'; }

__natalia_command_output_start() {
	if [ -z "${__natalia_first_prompt:-}" ]; then
		builtin return
	fi
	builtin printf '\033]633;E;%s\a' "$(__natalia_escape "${__natalia_command}")"
	builtin printf '\033]133;C\a'
}

__natalia_command_complete() {
	if [ -z "${__natalia_first_prompt:-}" ]; then
		__natalia_first_prompt=1
		builtin return
	fi
	if [ -z "${__natalia_command:-}" ]; then
		# No command ran — an empty prompt or an interrupt. The exit code is
		# deliberately ABSENT rather than 0: a reader must not be able to
		# mistake "nothing happened" for "succeeded".
		builtin printf '\033]133;D\a'
	else
		builtin printf '\033]133;D;%s\a' "$1"
	fi
}

# precmd runs before each prompt. zsh's own exit status is intact here.
__natalia_precmd() {
	builtin local natalia_status="$?"
	if [ -n "$__natalia_in_command" ]; then
		__natalia_command_complete "$natalia_status"
		__natalia_in_command=""
	fi
	__natalia_command=""
	__natalia_first_prompt=1
}

# preexec runs before each command, and HANDS the command over as $1 — no
# history parsing, no external command that could fail.
__natalia_preexec() {
	if [ -n "$__natalia_in_command" ]; then
		builtin return
	fi
	__natalia_in_command=1
	__natalia_command="$1"
	__natalia_command_output_start
}

add-zsh-hook precmd __natalia_precmd
add-zsh-hook preexec __natalia_preexec
