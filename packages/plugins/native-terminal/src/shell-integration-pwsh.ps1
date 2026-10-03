# Natalia shell integration for PowerShell.
#
# HOW THIS DIFFERS FROM BASH AND ZSH, and why it is not a translation of either.
# PowerShell has no preexec hook at all: no `trap DEBUG`, no `preexec` function. The only
# two seams are `Prompt` (drawn before every prompt) and `PSConsoleHostReadLine` (reads
# one line of input, when PSReadLine is loaded). So the command line comes from the
# RETURN VALUE of the read-line function rather than from a hook that fires before the
# command -- which is why this script overrides two functions where the others override
# one plus a hook.
#
# The hook shape follows VSCode's PowerShell integration (devref/vscode,
# terminal/common/scripts/shellIntegration.ps1), the only prior art that runs on this
# shell. Two deliberate departures:
#
#   1. The lifecycle markers are OSC 133, not 633. VSCode moved its own scripts to 633 to
#      be robust against confused applications; we emit 133 for bash and zsh and read 633
#      only for the command line, so one dialect across three shells is worth more than
#      fidelity to one of them.
#   2. The exit code comes from `$LASTEXITCODE`, not from `!$?`. `!$?` is a boolean
#      negation VSCode needs because it reports success alongside a history check; we
#      want the actual code, and `$LASTEXITCODE` is the native command's exit status.
#
# THE THREE INVARIANTS, the same as bash and zsh:
#   133;A  a prompt is being drawn
#   133;B  the command input is about to be accepted
#   633;E  the command line (133 has no field for it, so the one family that does carries
#          it -- exactly as bash and zsh do)
#   133;C  the command's output begins
#   133;D  the command finished, exit code after the semicolon. ABSENT when no command
#          ran: an empty prompt, an interrupt, a bare Enter. Nothing is invented here --
#          not 0, not an empty string -- so a reader can never mistake "nothing happened"
#          for "succeeded".
#
# "Did a command actually run" is answered by comparing the history id against the one
# last seen, which is VSCode's answer to the same problem and the one bash and zsh reach
# differently.

# Installed once per session. Without the guard a profile that re-sources this file wraps
# Prompt twice and every marker is emitted twice.
if ($Global:__NataliaState) {
	return
}

# Constrained language mode cannot define functions the way this needs. Refusing beats a
# half-installed integration that emits nothing.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
	return
}

$Global:__NataliaState = @{
	OriginalPrompt = $function:Prompt
	OriginalReadLine = $function:PSConsoleHostReadLine
	LastHistoryId = -1
	IsInExecution = $false
}

# Escape a value for embedding in an OSC sequence: control characters, the ESC that could
# terminate the sequence, the BEL that always does, and the semicolon that would start a
# new field. Encoded as \xNN, matching the bash and zsh scripts byte for byte so one
# parser reads all three.
function Global:__NataliaEscape([string]$Value) {
	[regex]::Replace(
		$Value,
		"[$([char]0x00)-$([char]0x1f)$([char]0x1b);]",
		{ param($Match)
			-Join ([System.Text.Encoding]::UTF8.GetBytes($Match.Value) | ForEach-Object { '\x{0:x2}' -f $_ })
		}
	)
}

function Global:__NataliaPromptEnd([int]$ExitCode) {
	# No new history entry since we last looked: Enter on an empty line, or an interrupt.
	# The code is left ABSENT rather than defaulted to 0.
	if ($Global:__NataliaState.LastHistoryId -eq (Get-History -Count 1).Id) {
		[Console]::Write("$([char]0x1b)]133;D`a")
		return
	}
	[Console]::Write("$([char]0x1b)]133;D;$ExitCode`a")
	$Global:__NataliaState.LastHistoryId = (Get-History -Count 1).Id
}

function Global:Prompt() {
	$ExitCode = $LASTEXITCODE
	Set-StrictMode -Off

	# A command only finishes if one started. `IsInExecution` is set by the read-line
	# override below, so a prompt that ran no command is silent here.
	if ($Global:__NataliaState.IsInExecution) {
		$Global:__NataliaState.IsInExecution = $false
		__NataliaPromptEnd $ExitCode
	}

	$Result = ''
	# 133;A -- a prompt is being drawn.
	$Result += "$([char]0x1b)]133;A`a"
	# 633;P;Cwd -- where the pane is, for a reader that wants it.
	$Result += "$([char]0x1b)]633;P;Cwd=$(__NataliaEscape $PWD.ProviderPath)`a"
	# The operator's own prompt still draws: this adds markers around it rather than
	# replacing it.
	$Result += $Global:__NataliaState.OriginalPrompt.Invoke()
	# 133;B -- the input is about to be accepted.
	$Result += "$([char]0x1b)]133;B`a"
	return $Result
}

# Written straight to the console rather than returned: a value returned from `Prompt` IS
# the prompt text, and these markers precede it in the stream.
[Console]::Write("$([char]0x1b)]633;P;PromptType=powershell`a")

# `PSConsoleHostReadLine` is a FUNCTION; the MODULE that provides it is `PSReadLine`.
# Checking the module by the function's name finds nothing and the override is silently
# skipped -- which is what the first version of this did, and the command line arrived
# empty with nothing in the argv looking wrong.
if (Get-Module -ListAvailable -Name PSReadLine) {
	Import-Module PSReadLine -ErrorAction SilentlyContinue
}
if (Get-Module -Name PSReadLine) {
	# The command line is this function's RETURN VALUE, the only place PowerShell exposes
	# what the user submitted. Overriding `Prompt` alone cannot learn it: Prompt runs
	# before the command is typed.
	function Global:PSConsoleHostReadLine() {
		$CommandLine = $Global:__NataliaState.OriginalReadLine.Invoke()
		$Global:__NataliaState.IsInExecution = $true

		# 633;E carries the command text; 133 has no field for it.
		$Result = "$([char]0x1b)]633;E;$(__NataliaEscape $CommandLine)`a"
		# 133;C -- the command's output begins.
		$Result += "$([char]0x1b)]133;C`a"
		[Console]::Write($Result)

		# Returning the line is the whole contract: swallow it and the shell stops reading
		# input at all.
		return $CommandLine
	}
}
