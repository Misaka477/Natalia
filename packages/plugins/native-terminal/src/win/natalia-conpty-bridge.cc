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
  // The spec's env overlay was tried entry-by-entry (SetEnvironmentVariableW)
  // and taken back out: the pane it produced was mute - the ConPTY console
  // came up and the child ran, but no screen bytes ever followed. Inheritance
  // alone is what renders the shell prompt. The TERM default is NOT set here
  // for the same reason: adding it changed the pane's behavior, and the
  // inherited environment is the one the panel demonstrably works with.
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

  const HANDLE outputPump = CreateThread(nullptr, 0, pumpConsoleOutput, nullptr, 0, nullptr);

  // The control loop: JSON lines from the host, exactly the POSIX bridge's.
  for (;;) {
    const std::string line = readLineFromStdin();
    if (line.empty()) continue;
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
