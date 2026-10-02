// ConPTY bridge - the Windows PTY, speaking the native-terminal pty bridge
// protocol exactly as the POSIX Python bridge does (a JSON spec line on stdin;
// `{kind} {size}\n`-framed output and a `{pid}` line on stdout; JSON-encoded
// input/resize/kill lines on stdin).
//
// It exists because the PTY backend has no other Windows answer: node-pty's
// native modules cannot load under bun (dlopen at init fails), and the Python
// bridge needs the POSIX pty module. ConPTY is the platform's own pseudo
// console, and this helper is the smallest process that turns it into the byte
// stream the pty controller already consumes - so the controller, the panel
// and the model all see the same real bytes Linux sees.

#include <windows.h>

#include <fcntl.h>
#include <io.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

HANDLE g_pcInputWrite = nullptr;   // our writes -> the console's keyboard
HANDLE g_pcOutputRead = nullptr;   // the console's screen -> our reads
HPCON g_pseudoConsole = nullptr;
HANDLE g_childProcess = nullptr;

void writeAll(const char *data, size_t length) {
  size_t written = 0;
  while (written < length) {
    DWORD chunk = 0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), data + written,
                   (DWORD)(length - written), &chunk, nullptr))
      return;
    if (chunk == 0) return;
    written += chunk;
  }
}

// The bridge's frame: `{kind} {size}\n` then the payload, raw.
void sendFrame(const char *kind, const char *payload, size_t length) {
  char header[64];
  int headerLength =
      _snprintf_s(header, sizeof(header), _TRUNCATE, "%s %zu\n", kind, length);
  writeAll(header, (size_t)headerLength);
  if (length > 0) writeAll(payload, length);
}

std::string readLineFromStdin() {
  std::string line;
  char byte = 0;
  DWORD read = 0;
  while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &read, nullptr) &&
         read == 1) {
    if (byte == '\n') break;
    line.push_back(byte);
  }
  if (!line.empty() && line.back() == '\r') line.pop_back();
  return line;
}

/**
 * The control-input queue, fed by a reader thread.
 *
 * A blocking ReadFile on stdin cannot ALSO notice the child exiting, and a child
 * that exits on its own — `cmd /c echo`, any short-lived command — used to leave
 * this bridge blocked in the read with its pane "running" forever and no exit
 * frame. The POSIX bridge emits its frame from its read loop when the master
 * closes; this is the same obligation, met by waiting on BOTH handles instead of
 * only the one.
 *
 * The reader owns the blocking read. The main loop owns the waiting, and is woken
 * by "a line arrived" OR "the child is gone".
 */
std::vector<std::string> g_lineQueue;
CRITICAL_SECTION g_queueLock;
HANDLE g_lineArrived = nullptr;
volatile bool g_stdinClosed = false;

DWORD WINAPI pumpControlInput(LPVOID) {
  for (;;) {
    const std::string line = readLineFromStdin();
    EnterCriticalSection(&g_queueLock);
    if (line.empty()) {
      // EOF: nothing more will ever arrive. Wake the loop so it can finish.
      g_stdinClosed = true;
      LeaveCriticalSection(&g_queueLock);
      SetEvent(g_lineArrived);
      return 0;
    }
    g_lineQueue.push_back(line);
    LeaveCriticalSection(&g_queueLock);
    SetEvent(g_lineArrived);
  }
  return 0;
}

/** Take the next queued line, if there is one. Keeps the event set while more remain. */
bool popControlLine(std::string *out) {
  EnterCriticalSection(&g_queueLock);
  if (g_lineQueue.empty()) {
    LeaveCriticalSection(&g_queueLock);
    ResetEvent(g_lineArrived);
    return false;
  }
  *out = g_lineQueue.front();
  g_lineQueue.erase(g_lineQueue.begin());
  const bool more = !g_lineQueue.empty();
  LeaveCriticalSection(&g_queueLock);
  if (more)
    SetEvent(g_lineArrived);
  else
    ResetEvent(g_lineArrived);
  return true;
}

// A JSON string value for a key: `"key":"value"` with backslash escapes.
// Minimal on purpose - the spec is produced by our own code.
bool extractString(const std::string &json, const char *key,
                   std::string *out) {
  const std::string needle = std::string("\"") + key + "\":\"";
  size_t at = json.find(needle);
  if (at == std::string::npos) return false;
  at += needle.size();
  std::string value;
  while (at < json.size()) {
    const char c = json[at++];
    if (c == '\\' && at < json.size()) {
      const char escaped = json[at++];
      switch (escaped) {
      case 'n': value.push_back('\n'); break;
        case 'r': value.push_back('\r'); break;
        case 't': value.push_back('\t'); break;
        case 'b': value.push_back('\b'); break;
        case 'f': value.push_back('\f'); break;
        case 'u': {
          if (at + 4 > json.size()) return false;
          const std::string hex = json.substr(at, 4);
          at += 4;
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

int extractNumber(const std::string &json, const char *key, int fallback) {
  const std::string needle = std::string("\"") + key + "\":";
  size_t at = json.find(needle);
  if (at == std::string::npos) return fallback;
  at += needle.size();
  return atoi(json.c_str() + at);
}

std::wstring widen(const std::string &text) {
  if (text.empty()) return std::wstring();
  const int needed =
      MultiByteToWideChar(CP_UTF8, 0, text.c_str(), (int)text.size(), nullptr, 0);
  std::wstring wide((size_t)needed, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), (int)text.size(), wide.data(),
                      needed);
  return wide;
}

std::wstring quote(const std::wstring &text) {
  std::wstring quoted = L"\"";
  for (const wchar_t c : text) {
    if (c == L'"') quoted += L"\\\"";
    else quoted.push_back(c);
  }
  quoted += L"\"";
  return quoted;
}

DWORD WINAPI pumpConsoleOutput(LPVOID) {
  char buffer[4096];
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(g_pcOutputRead, buffer, sizeof(buffer), &read, nullptr) ||
        read == 0)
      break;
    sendFrame("o", buffer, read);
  }
  return 0;
}

} // namespace

int main() {
  _setmode(_fileno(stdout), _O_BINARY);

  const std::string spec = readLineFromStdin();
  if (spec.empty()) {
    fprintf(stderr, "conpty-bridge: empty spec\n");
    return 1;
  }
  std::string file, cwd;
  if (!extractString(spec, "file", &file)) {
    fprintf(stderr, "conpty-bridge: spec has no file\n");
    return 1;
  }
  extractString(spec, "cwd", &cwd);
  const int cols = extractNumber(spec, "cols", 80);
  const int rows = extractNumber(spec, "rows", 24);

  // The command line: the executable followed by its JSON-escaped args.
  std::wstring commandLine = quote(widen(file));
  const std::string argsKey = "\"args\":[";
  size_t argsAt = spec.find(argsKey);
  if (argsAt != std::string::npos) {
    argsAt += argsKey.size();
    const std::string argsBlock = spec.substr(argsAt, spec.find(']', argsAt) - argsAt);
    size_t cursor = 0;
    while (cursor < argsBlock.size()) {
      const size_t quoteAt = argsBlock.find('"', cursor);
      if (quoteAt == std::string::npos) break;
      std::string encoded = argsBlock.substr(quoteAt + 1);
      encoded = encoded.substr(0, encoded.find('"'));
      cursor = quoteAt + encoded.size() + 2;
      std::string decoded;
      for (size_t i = 0; i < encoded.size(); i += 1) {
        if (encoded[i] == '\\' && i + 1 < encoded.size()) {
          const char escaped = encoded[++i];
          if (escaped == 'n') decoded.push_back('\n');
          else if (escaped == 'r') decoded.push_back('\r');
          else if (escaped == 't') decoded.push_back('\t');
          else if (escaped == '\\') decoded.push_back('\\');
          else if (escaped == '"') decoded.push_back('"');
          else decoded.push_back(escaped);
          continue;
        }
        decoded.push_back(encoded[i]);
      }
      commandLine += L" ";
      commandLine += quote(widen(decoded));
    }
  }

  // The two pipes the console's input and output travel through.
  HANDLE consoleInputRead = nullptr, consoleOutputWrite = nullptr;
  HANDLE ourInputWrite = nullptr, ourOutputRead = nullptr;
  SECURITY_ATTRIBUTES inheritable = {sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  if (!CreatePipe(&consoleInputRead, &ourInputWrite, &inheritable, 0)) return 2;
  if (!CreatePipe(&ourOutputRead, &consoleOutputWrite, &inheritable, 0)) return 2;
  g_pcInputWrite = ourInputWrite;
  g_pcOutputRead = ourOutputRead;

  COORD size;
  size.X = (SHORT)cols;
  size.Y = (SHORT)rows;
  if (CreatePseudoConsole(size, consoleInputRead, consoleOutputWrite, 0,
                          &g_pseudoConsole) != S_OK) {
    fprintf(stderr, "conpty-bridge: CreatePseudoConsole failed\n");
    return 3;
  }

  STARTUPINFOEXW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.StartupInfo.cb = sizeof(startup);
  SIZE_T attributeListSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeListSize);
  startup.lpAttributeList =
      (LPPROC_THREAD_ATTRIBUTE_LIST)malloc(attributeListSize);
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0,
                                         &attributeListSize))
    return 4;
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0,
                                 PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                 g_pseudoConsole, sizeof(g_pseudoConsole),
                                 nullptr, nullptr))
    return 5;

  PROCESS_INFORMATION process;
  ZeroMemory(&process, sizeof(process));
  const std::wstring workingDirectory = cwd.empty() ? std::wstring() : widen(cwd);
  // The child inherits the bridge's environment (lpEnvironment = nullptr).
  //
  // The spec's env overlay is NOT applied, and that is a DIVERGENCE from the
  // POSIX bridge (pty-terminal-controller.ts does `env.update(spec.get("env"))`).
  // It is not the cause of the mute pane — the report excluded env by building
  // both ways and seeing the same silence — and this comment used to imply
  // otherwise, which sent a later reader looking in the wrong place. The overlay
  // is still off because re-adding it was never the goal; if it is wanted, the
  // safe Windows spelling is a SORTED block passed as lpEnvironment, not
  // SetEnvironmentVariableW, because Windows requires the block sorted by name.
  //
  // With a pseudo-console, CreateProcessW takes the command line ONLY: passing
  // lpApplicationName alongside the attribute list fails with
  // ERROR_INVALID_PARAMETER. commandLine already starts with the quoted exe.
  if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, FALSE,
                      EXTENDED_STARTUPINFO_PRESENT,
                      nullptr, /* DIAG: env disabled */
                      workingDirectory.empty() ? nullptr : workingDirectory.c_str(),
                      &startup.StartupInfo, &process)) {
    fprintf(stderr, "conpty-bridge: CreateProcess failed (%lu)\n",
            GetLastError());
    return 6;
  }
  g_childProcess = process.hProcess;
  CloseHandle(process.hThread);

  char pidLine[64];
  const int pidLength = _snprintf_s(pidLine, sizeof(pidLine), _TRUNCATE,
                                    "{\"pid\":%lu}\n", process.dwProcessId);
  writeAll(pidLine, (size_t)pidLength);

  // P23's fix, from the ranked direction list in the report: re-apply the spec's
  // size once the child exists.
  //
  // The mute pane was this — the console's initialisation sequence
  // (ESC[?9001h ESC[?1004h) arrives and then nothing does. The child is alive
  // and blocked at zero CPU, and input does not reach it. The evidence ruled out
  // the binary, the environment, the console pool and a reboot, and the one
  // variable never ruled out was the HOST side of the handshake: the successful
  // run differed only in that the pane had been resized before it.
  //
  // ConPTY's viewport is negotiated between the host and conhost, and a
  // CreatePseudoConsole size does not reliably trigger that negotiation on its
  // own — until something resizes, no screen bytes flow. Saying the same size
  // again is what forces it, and it is the same call the "resize" message below
  // makes, so there is no second mechanism to maintain.
  //
  // If a same-size resize turns out to be a no-op on some host, the next step is
  // the nudge-and-restore variant (size+1 then back), not a new mechanism.
  //
  // It reports to stderr rather than staying silent: the next Windows run should
  // be able to confirm or refute this in ONE run, and a fix that cannot be told
  // apart from nothing happening is not a fix. The line also records the size,
  // because "the handshake ran with the wrong viewport" is the other way this
  // fails.
  const HRESULT resized = ResizePseudoConsole(g_pseudoConsole, size);
  fprintf(stderr,
          "conpty-bridge: viewport handshake requested %ux%u (hr=%#lx)\n",
          (unsigned)size.X, (unsigned)size.Y, (unsigned long)resized);

  const HANDLE outputPump = CreateThread(nullptr, 0, pumpConsoleOutput, nullptr, 0, nullptr);

  // The control loop: JSON lines from the host, exactly the POSIX bridge's —
  // but read on a thread, so the loop can also be woken by the CHILD exiting.
  // Without that, `cmd /c echo` (any short-lived command) left the bridge blocked
  // on stdin with its pane "running" and no exit frame.
  g_lineArrived = CreateEvent(nullptr, TRUE, FALSE, nullptr);
  InitializeCriticalSection(&g_queueLock);
  const HANDLE controlReader =
      CreateThread(nullptr, 0, pumpControlInput, nullptr, 0, nullptr);

  for (;;) {
    std::string line;
    if (!popControlLine(&line)) {
      // Nothing queued: wait for a line to arrive OR the child to exit. Either
      // one is news, and before the reader thread existed only the first could
      // ever wake this.
      const HANDLE waitFor[] = {g_lineArrived, g_childProcess};
      const DWORD which = WaitForMultipleObjects(2, waitFor, FALSE, INFINITE);
      if (which == WAIT_OBJECT_0 + 1) break; // the child is gone
      if (which != WAIT_OBJECT_0) break;     // an error: nothing left to wait for
      if (!popControlLine(&line)) {
        // Woken with an empty queue: either a spurious wake, or EOF (the host
        // closed stdin). Exit only when there is truly nothing left to do.
        if (g_stdinClosed) break;
        continue;
      }
    }
    std::string type;
    extractString(line, "type", &type);
    if (type == "input") {
      std::string text;
      extractString(line, "data", &text);
      if (!text.empty()) {
        DWORD written = 0;
        WriteFile(g_pcInputWrite, text.data(), (DWORD)text.size(), &written,
                  nullptr);
      }
      continue;
    }
    if (type == "resize") {
      const int nextCols = extractNumber(line, "cols", cols);
      const int nextRows = extractNumber(line, "rows", rows);
      COORD next;
      next.X = (SHORT)nextCols;
      next.Y = (SHORT)nextRows;
      ResizePseudoConsole(g_pseudoConsole, next);
      continue;
    }
    if (type == "kill") {
      TerminateProcess(g_childProcess, 1);
      break;
    }
  }
  if (controlReader) CloseHandle(controlReader);

  WaitForSingleObject(g_childProcess, INFINITE);
  DWORD exitCode = 0;
  GetExitCodeProcess(g_childProcess, &exitCode);
  char exitLine[64];
  const int exitLength = _snprintf_s(exitLine, sizeof(exitLine), _TRUNCATE,
                                     "x %lu\n", exitCode);
  writeAll(exitLine, (size_t)exitLength);
  if (outputPump) {
    WaitForSingleObject(outputPump, 2000);
    CloseHandle(outputPump);
  }
  return 0;
}
