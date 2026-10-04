// The Windows GUI entry point: ONE parent process that owns its children.
//
// Architecture, deliberately like every real desktop app (VS Code, Chrome):
// this process is the parent. The runtime API, the static web server and the
// window host are its CHILDREN, all assigned to a Job Object, so the process
// tree is a tree — one parent, N children, no orphans, nothing scattered. When
// the parent exits the job closes and the children go with it; when a child
// dies the parent is still the parent.
//
// What this REPLACES is worth recording. The previous two attempts:
//   * a .cmd launcher using `start /b`: children shared the batch file's
//     console, so when the script ended the console closed and took both
//     servers with it, and the browser tab it had just opened failed every API
//     call with ERR_CONNECTION_REFUSED;
//   * a .cmd launcher holding itself open: same script, one stray cmd.exe and
//     two servers as loose processes nobody owned.
// Both are "a pile of processes". This is a parent.
//
// Ports are not free choices: the web shell's runtime client is compiled with
// `VITE_NATALIA_RUNTIME_URL || "http://127.0.0.1:8790"`, so the runtime owns
// 8790 or the app loads and 404s every API call — it opens and cannot configure
// a model.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>

#include <string>
#include <vector>

namespace {

const wchar_t kRuntimePort[] = L"8790";
const wchar_t kWebPort[] = L"8791";

/** The job every child is assigned to. Kills them all when the parent goes. */
HANDLE g_job = nullptr;

std::wstring ExeDir() {
  wchar_t path[MAX_PATH] = {0};
  GetModuleFileNameW(nullptr, path, MAX_PATH);
  std::wstring dir(path);
  const size_t slash = dir.find_last_of(L"\\/");
  return slash == std::wstring::npos ? dir : dir.substr(0, slash + 1);
}

void Log(const std::wstring& line) {
  wchar_t temp[MAX_PATH] = {0};
  GetTempPathW(MAX_PATH, temp);
  const std::wstring path = std::wstring(temp) + L"natalia-launcher.log";
  HANDLE file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ,
                            nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                            nullptr);
  if (file == INVALID_HANDLE_VALUE) return;
  const std::string narrow(line.begin(), line.end());
  DWORD written = 0;
  WriteFile(file, narrow.data(), static_cast<DWORD>(narrow.size()), &written,
            nullptr);
  CloseHandle(file);
}

/**
 * Starts a child and returns its process handle, or nullptr.
 *
 * The handle matters: the parent keeps it so it can wait on the child and know
 * when it exits. The job assignment is what makes it a CHILD rather than a
 * stray process — when this parent dies for any reason, the job closes and the
 * child dies with it.
 */
HANDLE StartChild(const std::wstring& executable,
                  const std::wstring& arguments) {
  std::wstring command = L"\"" + executable + L"\" " + arguments;
  STARTUPINFOW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process;
  ZeroMemory(&process, sizeof(process));
  if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr,
                      FALSE, 0, nullptr, nullptr, &startup, &process))
    return nullptr;
  CloseHandle(process.hThread);
  if (g_job) AssignProcessToJobObject(g_job, process.hProcess);
  return process.hProcess;
}

/** True once something answers on the port. */
bool PortIsOpen(int port) {
  const SOCKET socket = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (socket == INVALID_SOCKET) return false;
  sockaddr_in address;
  ZeroMemory(&address, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(static_cast<u_short>(port));
  InetPtonA(AF_INET, "127.0.0.1", &address.sin_addr);
  const bool connected =
      ::connect(socket, reinterpret_cast<sockaddr*>(&address),
                sizeof(address)) == 0;
  ::closesocket(socket);
  return connected;
}

bool WaitForPort(int port, int attempts) {
  for (int i = 0; i < attempts; ++i) {
    if (PortIsOpen(port)) return true;
    Sleep(250);
  }
  return false;
}

}  // namespace

int APIENTRY wWinMain(HINSTANCE instance,
                      HINSTANCE previous,
                      LPWSTR command_line,
                      int show) {
  UNREFERENCED_PARAMETER(instance);
  UNREFERENCED_PARAMETER(previous);
  UNREFERENCED_PARAMETER(command_line);
  UNREFERENCED_PARAMETER(show);

  // Winsock, for the readiness probe. Without WSAStartup every socket() returns
  // INVALID_SOCKET, so the probe reports a dead server that is in fact serving —
  // that is how "the web server never came up" appeared in the log beside a 200
  // from the same port.
  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);

  // The job first: a child started before it exists would be outside the tree.
  g_job = CreateJobObjectW(nullptr, nullptr);
  if (g_job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    ZeroMemory(&limits, sizeof(limits));
    // Kill every child when this parent goes, for any reason including a crash.
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &limits,
                            sizeof(limits));
  }

  const std::wstring app = ExeDir();
  const std::wstring runtime = app + L"natalia.exe";
  const std::wstring windowHost = app + L"natalia-cef-desktop.exe";
  const std::wstring webUrl =
      L"http://127.0.0.1:" + std::wstring(kWebPort) + L"/";

  Log(L"[natalia] parent starting; job owns the children from here");

  HANDLE servers[2] = {nullptr, nullptr};
  servers[0] = StartChild(runtime, L"serve --port " + std::wstring(kRuntimePort));
  if (!servers[0]) Log(L"[natalia] the runtime did not start");
  servers[1] = StartChild(runtime,
                          L"serve-web --root \"" + app + L"web\" --port " +
                              std::wstring(kWebPort));
  if (!servers[1]) Log(L"[natalia] the web server did not start");

  // Wait for the shell to answer before handing its URL to a window: a window
  // that loads before its listener exists never retries.
  if (WaitForPort(_wtoi(kWebPort), 40))
    Log(L"[natalia] the web server is ready");
  else
    Log(L"[natalia] the web server never came up on " +
        std::wstring(kWebPort));

  // The window host is a child too, so the tree stays one parent deep.
  Log(L"[natalia] starting the window host");
  HANDLE window =
      StartChild(windowHost, L"--url=\"" + webUrl + L"\" --user-data-dir=\"" +
                                 app + L"user-data\"");
  DWORD windowExit = 1;
  if (window) {
    WaitForSingleObject(window, INFINITE);
    GetExitCodeProcess(window, &windowExit);
    CloseHandle(window);
    Log(L"[natalia] the window host exited with " +
        std::to_wstring(windowExit));
  } else {
    Log(L"[natalia] the window host could not be started at all");
  }

  if (windowExit == 0) {
    // The window closed on its own terms: the app is done.
    Log(L"[natalia] the window closed; the parent is exiting");
    CloseHandle(g_job);  // the job closes and the servers go with it
    return 0;
  }

  // The window is what the user is owed; which window is a preference, and a
  // crashed host must not take the app down. The servers are children of this
  // parent, so they stay up as long as it does — and this parent does not exit
  // until the user is finished, which is the one-parent model. Closing this
  // process from the taskbar kills the job and every child with it.
  Log(L"[natalia] the window host failed; opening the app in the browser");
  ShellExecuteW(nullptr, L"open", webUrl.c_str(), nullptr, nullptr,
                SW_SHOWNORMAL);
  Log(L"[natalia] the parent stays alive with its servers; close it to stop");
  // Wait on the servers: this returns when they exit on their own, which in
  // practice means the user stopped the app.
  WaitForMultipleObjects(2, servers, TRUE, INFINITE);
  CloseHandle(g_job);
  return 0;
}
