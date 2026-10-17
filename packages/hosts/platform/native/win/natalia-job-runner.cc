// Job runner - the Windows owner of a detached process TREE.
//
// A detached background process on Windows has no process group to signal:
// `taskkill /T` walks a snapshot of parent/child links and misses anything that
// re-parented itself, and the launcher's own pid is what the caller had to keep
// and signal. This helper makes the OWNER explicit, which is the shape the
// reference implementation uses (`launchWindowsJob`: one runner per launch, the
// runner uniquely owns the job handle, termination is a message to the runner):
//
//   * it creates a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so the
//     job dies with its last handle — no orphan tree when the owner goes away;
//   * it starts the target SUSPENDED, assigns it to the job, then resumes it, so
//     nothing the target spawns can escape the job by racing the assignment;
//   * it reports `{"pid":N}` (the TARGET's pid) on stdout and stays alive as the
//     owner: the pid the caller keeps is this runner's, and this runner's
//     liveness is the target's liveness;
//   * `{"type":"terminate"}` on stdin terminates the whole job at once.
//
// The protocol is the pty bridge's: one JSON spec line on stdin, JSON lines on
// stdout, plain words on stderr. Keeping one shape means one parser to trust.
//
// It is NOT a console program: the target runs with CREATE_NO_WINDOW and
// CREATE_UNICODE_ENVIRONMENT, and the caller spawns this runner with
// `windowsHide: true`. A detached start must never open a window — that was a
// measured defect of the previous shape (DETACHED_PROCESS made the first console
// app allocate a visible console), and it is a property of this helper now.

#include <windows.h>

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

namespace {

/**
 * Informational traces are OPT-IN, failures always print — the same rule the
 * pty bridge follows, for the same reason: one runner per detached process, so
 * narration belongs in whatever stderr the host inherited only when asked.
 */
bool informationalLogging() {
  const char *value = std::getenv("NATALIA_JOB_RUNNER_VERBOSE");
  return value != nullptr && value[0] != '\0' && std::strcmp(value, "0") != 0;
}

void note(const char *format, ...) {
  if (!informationalLogging()) return;
  va_list args;
  va_start(args, format);
  std::vfprintf(stderr, format, args);
  va_end(args);
}

void fail(const char *format, ...) {
  va_list args;
  va_start(args, format);
  std::vfprintf(stderr, format, args);
  va_end(args);
}

void writeAll(const char *data, size_t length) {
  size_t written = 0;
  while (written < length) {
    const DWORD chunk =
        (DWORD)((length - written) > 0x40000000 ? 0x40000000 : (length - written));
    DWORD produced = 0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), data + written, chunk,
                   &produced, nullptr) ||
        produced == 0)
      return;
    written += produced;
  }
}

void sendLine(const std::string &line) {
  writeAll(line.data(), line.size());
  writeAll("\n", 1);
}

/** One line from stdin, without its newline; empty at EOF. */
std::string readLineFromStdin() {
  std::string line;
  char buffer[4096];
  for (;;) {
    const DWORD read = [] (char *into, DWORD size) {
      DWORD produced = 0;
      if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), into, size, &produced, nullptr))
        return (DWORD)0;
      return produced;
    }(buffer, sizeof(buffer));
    if (read == 0) return line;
    for (DWORD index = 0; index < read; index += 1) {
      if (buffer[index] == '\n') return line;
      line.push_back(buffer[index]);
    }
  }
}

std::wstring widen(const std::string &text) {
  if (text.empty()) return std::wstring();
  const int needed =
      MultiByteToWideChar(CP_UTF8, 0, text.c_str(), (int)text.size(), nullptr, 0);
  if (needed <= 0) return std::wstring();
  std::wstring wide((size_t)needed, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), (int)text.size(), wide.data(),
                      needed);
  return wide;
}

size_t skipJsonSpace(const std::string &json, size_t at) {
  while (at < json.size() &&
         (json[at] == ' ' || json[at] == '\t' || json[at] == '\n' ||
          json[at] == '\r'))
    at += 1;
  return at;
}

bool findJsonValue(const std::string &json, const char *key, size_t *at) {
  const std::string needle = std::string("\"") + key + "\"";
  size_t scan = 0;
  for (;;) {
    scan = json.find(needle, scan);
    if (scan == std::string::npos) return false;
    scan += needle.size();
    scan = skipJsonSpace(json, scan);
    if (scan < json.size() && json[scan] == ':') {
      *at = skipJsonSpace(json, scan + 1);
      return true;
    }
  }
}

/** A JSON string value, with the escapes the spec carries. */
bool extractString(const std::string &json, const char *key, std::string *out) {
  size_t at = 0;
  if (!findJsonValue(json, key, &at)) return false;
  if (at >= json.size() || json[at] != '"') return false;
  at += 1;
  std::string value;
  while (at < json.size()) {
    const char c = json[at++];
    if (c == '\\' && at < json.size()) {
      const char escaped = json[at++];
      switch (escaped) {
      case 'n': value.push_back('\n'); break;
      case 'r': value.push_back('\r'); break;
      case 't': value.push_back('\t'); break;
      case '\\': value.push_back('\\'); break;
      case '"': value.push_back('"'); break;
      default: value.push_back(escaped); break;
      }
      continue;
    }
    if (c == '"') {
      *out = value;
      return true;
    }
    value.push_back(c);
  }
  return false;
}

/**
 * Reads the JSON string that starts at `at` (which must be the opening quote)
 * and advances `at` past the closing quote.
 *
 * One decoder for every string the spec carries, so an escape means exactly one
 * thing: `\"` is a quote INSIDE a value, `\\` is one backslash, and a value is
 * allowed to hold braces, brackets and quotes of its own.
 */
bool readJsonString(const std::string &json, size_t *at, std::string *out) {
  if (*at >= json.size() || json[*at] != '"') return false;
  *at += 1;
  std::string value;
  while (*at < json.size()) {
    const char c = json[(*at)++];
    if (c == '\\' && *at < json.size()) {
      const char escaped = json[(*at)++];
      switch (escaped) {
      case 'n': value.push_back('\n'); break;
      case 'r': value.push_back('\r'); break;
      case 't': value.push_back('\t'); break;
      case 'b': value.push_back('\b'); break;
      case 'f': value.push_back('\f'); break;
      case 'u': {
        if (*at + 4 > json.size()) return false;
        const std::string hex = json.substr(*at, 4);
        *at += 4;
        const long code = strtol(hex.c_str(), nullptr, 16);
        if (code < 0x80) {
          value.push_back((char)code);
        } else if (code < 0x800) {
          value.push_back((char)(0xC0 | (code >> 6)));
          value.push_back((char)(0x80 | (code & 0x3F)));
        } else {
          value.push_back((char)(0xE0 | (code >> 12)));
          value.push_back((char)(0x80 | ((code >> 6) & 0x3F)));
          value.push_back((char)(0x80 | (code & 0x3F)));
        }
        break;
      }
      default: value.push_back(escaped); break;
      }
      continue;
    }
    if (c == '"') {
      *out = value;
      return true;
    }
    value.push_back(c);
  }
  return false;
}

/** `"key": ["a","b"]` as decoded strings, quote-aware. */
std::vector<std::string> extractStringArray(const std::string &json,
                                            const char *key) {
  std::vector<std::string> values;
  size_t at = 0;
  if (!findJsonValue(json, key, &at)) return values;
  if (at >= json.size() || json[at] != '[') return values;
  at += 1;
  for (;;) {
    at = skipJsonSpace(json, at);
    if (at >= json.size()) break;
    if (json[at] == ']') break;
    if (json[at] == ',') {
      at = skipJsonSpace(json, at + 1);
      continue;
    }
    if (json[at] != '"') break;
    std::string value;
    if (!readJsonString(json, &at, &value)) break;
    values.push_back(value);
    at = skipJsonSpace(json, at);
  }
  return values;
}

/**
 * `"key": {"NAME":"value"}` as ordered pairs.
 *
 * The scan is quote-aware, so a value may hold anything — braces, brackets and
 * quotes of its own — and the reader never mistakes one of them for the object's
 * end. The first version of this parser was correct on that count too (both were
 * fed the platform's worker script, which carries a `}`, and both delivered it);
 * it was replaced for shape, not because it failed. What actually broke the
 * detached chain was stdio inheritance — see the CreateProcessW call.
 */
std::vector<std::pair<std::string, std::string>> extractStringMap(
    const std::string &json, const char *key) {
  std::vector<std::pair<std::string, std::string>> pairs;
  size_t at = 0;
  if (!findJsonValue(json, key, &at)) return pairs;
  if (at >= json.size() || json[at] != '{') return pairs;
  at += 1;
  for (;;) {
    at = skipJsonSpace(json, at);
    if (at >= json.size()) break;
    if (json[at] == '}') break;
    if (json[at] == ',') {
      at = skipJsonSpace(json, at + 1);
      continue;
    }
    if (json[at] != '"') break;
    std::string name;
    if (!readJsonString(json, &at, &name)) break;
    at = skipJsonSpace(json, at);
    if (at >= json.size() || json[at] != ':') break;
    at = skipJsonSpace(json, at + 1);
    if (at >= json.size() || json[at] != '"') break;
    std::string value;
    if (!readJsonString(json, &at, &value)) break;
    pairs.emplace_back(name, value);
    at = skipJsonSpace(json, at);
  }
  return pairs;
}

/** The CreateProcessW/CommandLineToArgvW rule: quote only when the argument
 *  needs it, and escape the backslashes that precede a closing quote. */
bool needsQuoting(const std::wstring &text) {
  if (text.empty()) return true;
  return text.find_first_of(L" \t\n\v\"") != std::wstring::npos;
}

std::wstring quote(const std::wstring &text) {
  std::wstring quoted = L"\"";
  size_t backslashes = 0;
  for (const wchar_t c : text) {
    if (c == L'\\') {
      backslashes += 1;
      continue;
    }
    if (c == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'"');
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted.push_back(c);
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

/**
 * The child's environment: this runner's own block with the spec's overlay on
 * top, sorted case-insensitively by name (Windows requires it) and terminated by
 * an empty string. Entries beginning with `=` (the console's per-drive current
 * directories) are left out: CreateProcessW rejects a caller-built block that
 * carries them.
 */
std::vector<wchar_t> buildEnvironmentBlock(
    const std::vector<std::pair<std::string, std::string>> &overlay) {
  std::vector<std::pair<std::wstring, std::wstring>> entries;
  const auto put = [&entries](const std::wstring &name,
                              const std::wstring &value) {
    for (auto &entry : entries)
      if (_wcsicmp(entry.first.c_str(), name.c_str()) == 0) {
        entry.second = value;
        return;
      }
    entries.emplace_back(name, value);
  };
  LPWCH current = GetEnvironmentStringsW();
  if (current != nullptr) {
    for (const wchar_t *cursor = current; *cursor != L'\0';) {
      const std::wstring entry(cursor);
      cursor += entry.size() + 1;
      if (!entry.empty() && entry[0] == L'=') continue;
      const size_t split = entry.find(L'=');
      if (split == std::wstring::npos) continue;
      put(entry.substr(0, split), entry.substr(split + 1));
    }
    FreeEnvironmentStringsW(current);
  }
  for (const auto &pair : overlay) put(widen(pair.first), widen(pair.second));
  std::sort(entries.begin(), entries.end(),
            [](const std::pair<std::wstring, std::wstring> &left,
               const std::pair<std::wstring, std::wstring> &right) {
              return _wcsicmp(left.first.c_str(), right.first.c_str()) < 0;
            });
  std::vector<wchar_t> block;
  for (const auto &entry : entries) {
    const std::wstring line = entry.first + L"=" + entry.second;
    block.insert(block.end(), line.begin(), line.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

HANDLE g_job = nullptr;
volatile LONG g_terminated = 0;

/**
 * Reads terminate messages from the host and ends the job when one arrives.
 *
 * Terminating the JOB, not a process: every descendant dies with it, including
 * the ones a snapshot walk cannot see. The thread also ends on stdin EOF — the
 * host that started this runner closing its end means nobody is left to ask for
 * the tree, and a runner that outlived its host would hold the job open forever.
 */
DWORD WINAPI controlLoop(LPVOID) {
  for (;;) {
    const std::string line = readLineFromStdin();
    if (line.empty()) break;
    if (line.find("\"terminate\"") != std::string::npos) {
      note("job-runner: terminate requested\n");
      InterlockedExchange(&g_terminated, 1);
      if (g_job != nullptr) TerminateJobObject(g_job, 1);
      break;
    }
  }
  return 0;
}

} // namespace

int main() {
  const std::string spec = readLineFromStdin();
  if (spec.empty()) {
    fail("job-runner: empty spec\n");
    return 1;
  }
  std::string file, cwd;
  if (!extractString(spec, "file", &file)) {
    fail("job-runner: spec has no file\n");
    return 1;
  }
  extractString(spec, "cwd", &cwd);
  const std::vector<std::string> args = extractStringArray(spec, "args");
  const std::vector<std::pair<std::string, std::string>> environmentOverlay =
      extractStringMap(spec, "env");

  std::wstring commandLine = quote(widen(file));
  for (const std::string &arg : args) {
    const std::wstring wide = widen(arg);
    commandLine += L" ";
    commandLine += needsQuoting(wide) ? quote(wide) : wide;
  }

  // The job the target lives in. KILL_ON_JOB_CLOSE is the whole point: when this
  // runner ends — normally, by request, or by being killed — the last handle
  // closes and Windows ends the tree.
  g_job = CreateJobObjectW(nullptr, nullptr);
  if (g_job != nullptr) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    ZeroMemory(&limits, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &limits,
                                 sizeof(limits))) {
      fail("job-runner: SetInformationJobObject failed (%lu)\n", GetLastError());
      CloseHandle(g_job);
      g_job = nullptr;
    }
  } else {
    fail("job-runner: CreateJobObject failed (%lu)\n", GetLastError());
  }

  STARTUPINFOW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process;
  ZeroMemory(&process, sizeof(process));
  const std::wstring workingDirectory = cwd.empty() ? std::wstring() : widen(cwd);
  std::vector<wchar_t> environmentBlock = buildEnvironmentBlock(environmentOverlay);

  // CREATE_SUSPENDED, then assign, then resume. A target that started running
  // before the assignment could spawn a child that the job never sees — the
  // escape window is the whole reason this is two steps.
  //
  // bInheritHandles TRUE, and no STARTF_USESTDHANDLES: the TARGET inherits this
  // runner's own stdio, which is the log file the caller opened. That is not a
  // detail — a detached pwsh whose stdio handles it cannot use exits WITHOUT
  // running its command (measured on pwsh 7.4: `-Command "exit 42"` answers 0
  // and writes nothing), and the ConPTY idiom of STARTF_USESTDHANDLES with NULL
  // handles only works because a pseudo-console owns them. A detached process
  // has no pseudo-console, so it inherits the runner's handles or it has none.
  const DWORD flags = CREATE_SUSPENDED | CREATE_NO_WINDOW |
                      CREATE_UNICODE_ENVIRONMENT |
                      (g_job != nullptr ? 0 : CREATE_NEW_PROCESS_GROUP);
  if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, TRUE, flags,
                      environmentBlock.empty() ? nullptr : environmentBlock.data(),
                      workingDirectory.empty() ? nullptr : workingDirectory.c_str(),
                      &startup, &process)) {
    fail("job-runner: CreateProcess failed (%lu)\n", GetLastError());
    if (g_job != nullptr) CloseHandle(g_job);
    return 2;
  }

  if (g_job != nullptr && !AssignProcessToJobObject(g_job, process.hProcess)) {
    // Nested jobs are supported on Windows 8+; a host that forbids them loses
    // the tree guarantee but keeps the process, and the caller's own fallback
    // (`taskkill /T`) is still there. Said out loud, never silent: this is the
    // difference between "the tree is owned" and "the tree usually dies".
    fail("job-runner: AssignProcessToJobObject failed (%lu); the process runs "
         "without job ownership\n",
         GetLastError());
    CloseHandle(g_job);
    g_job = nullptr;
  }
  note("job-runner: started pid=%lu (%zu args, %zu env entries)\n",
       (unsigned long)process.dwProcessId, args.size(), environmentOverlay.size());
  ResumeThread(process.hThread);
  CloseHandle(process.hThread);

  const std::string pidLine =
      std::string("{\"pid\":") + std::to_string((unsigned long)process.dwProcessId) +
      "}";
  sendLine(pidLine);

  const HANDLE control = CreateThread(nullptr, 0, controlLoop, nullptr, 0, nullptr);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exitCode = 0;
  GetExitCodeProcess(process.hProcess, &exitCode);
  CloseHandle(process.hProcess);
  sendLine(std::string("{\"exit\":") + std::to_string((unsigned long)exitCode) + "}");
  if (control != nullptr) {
    // The reader is blocked on stdin; ending it here would leak the thread, so
    // the process simply exits — Windows closes the handle with it.
    CloseHandle(control);
  }
  if (g_job != nullptr) CloseHandle(g_job);
  return (int)exitCode;
}
