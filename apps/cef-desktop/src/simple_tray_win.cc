// Copyright (c) 2026 The Natalia Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// The Windows tray icon — see simple_tray_win.h for why this is a private
// message-only window and not a subclass of the browser's.

#include "simple_tray_win.h"

#include <shellapi.h>

namespace natalia {
namespace {

// Above the reserved range (>= 0x8000 reserved-by-Microsoft) and below WM_APP,
// so it cannot collide with anything the shell or the framework sends.
constexpr UINT kTrayCallbackMessage = WM_APP + 1;
constexpr UINT_PTR kCommandShow = 1001;
constexpr UINT_PTR kCommandQuit = 1002;
constexpr wchar_t kWindowClassName[] = L"NataliaTrayMessageWindow";

constexpr UINT kTaskbarCreatedMessage = 0x5370;  // RegisterWindowMessage value.

}  // namespace

TrayIcon* TrayIcon::Create(HICON icon,
                           const std::wstring& tooltip,
                           const TrayCallbacks& callbacks) {
  auto* tray = new TrayIcon();
  tray->icon_ = icon;
  tray->tooltip_ = tooltip;
  tray->callbacks_ = callbacks;

  // The class must be registered before the window is created. Registering
  // repeatedly is harmless (the atom is stable), which matters because the
  // browser can create more than one icon-shaped window over its lifetime.
  WNDCLASSEXW window_class{};
  window_class.cbSize = sizeof(window_class);
  window_class.lpfnWndProc = TrayIcon::WindowProc;
  window_class.hInstance = ::GetModuleHandleW(nullptr);
  window_class.lpszClassName = kWindowClassName;
  ::RegisterClassExW(&window_class);  // Already-registered is not an error.

  // A message-only window: it has no z-order, no visibility and cannot be
  // activated, which is exactly what a callback sink wants.
  tray->hwnd_ = ::CreateWindowExW(
      0, kWindowClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, nullptr,
      nullptr);
  if (!tray->hwnd_) {
    delete tray;
    return nullptr;
  }
  ::SetWindowLongPtrW(tray->hwnd_, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(tray));

  if (!tray->RegisterIcon()) {
    // An icon the shell refused is a degraded app, not a broken one: the window
    // still works, so the caller keeps the object (its destructor removes the
    // window) but reports the tray as absent.
    return tray;
  }
  return tray;
}

TrayIcon::~TrayIcon() {
  if (hwnd_) {
    if (registered_) ::Shell_NotifyIconW(NIM_DELETE, &icon_data_);
    ::DestroyWindow(hwnd_);
  }
}

bool TrayIcon::RegisterIcon() {
  icon_data_ = {};
  icon_data_.cbSize = sizeof(icon_data_);
  icon_data_.hWnd = hwnd_;
  icon_data_.uID = 1;
  icon_data_.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  icon_data_.uCallbackMessage = kTrayCallbackMessage;
  icon_data_.hIcon = icon_ ? icon_ : ::LoadIconW(nullptr, IDI_APPLICATION);
  wcsncpy_s(icon_data_.szTip, tooltip_.c_str(), _TRUNCATE);
  registered_ = ::Shell_NotifyIconW(NIM_ADD, &icon_data_);
  return registered_;
}

void TrayIcon::RestoreAfterTaskbarCreated() {
  // Explorer restarting is the documented case where the shell drops the icon
  // without telling anyone. Re-adding is the documented fix.
  if (hwnd_ && !registered_) RegisterIcon();
}

LRESULT CALLBACK TrayIcon::WindowProc(HWND hwnd,
                                      UINT message,
                                      WPARAM w_param,
                                      LPARAM l_param) {
  auto* self =
      reinterpret_cast<TrayIcon*>(::GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  if (!self) return ::DefWindowProcW(hwnd, message, w_param, l_param);

  if (message == kTrayCallbackMessage) {
    // The low word of l_param is the event; WM_RBUTTONUP and WM_CONTEXTMENU are
    // both handled because which one arrives is a Windows-version detail.
    const UINT event = LOWORD(l_param);
    if (event == WM_RBUTTONUP || event == WM_CONTEXTMENU ||
        event == WM_LBUTTONDBLCLK) {
      if (event == WM_LBUTTONDBLCLK && self->callbacks_.on_show)
        self->callbacks_.on_show();
      else
        self->ShowContextMenu();
      return 0;
    }
    return 0;
  }

  // Explorer restarting drops the icon without telling anyone; re-adding is the
  // documented fix.
  if (message == kTaskbarCreatedMessage) {
    self->RestoreAfterTaskbarCreated();
    return 0;
  }

  if (message == WM_COMMAND) {
    switch (LOWORD(w_param)) {
      case kCommandShow:
        if (self->callbacks_.on_show) self->callbacks_.on_show();
        return 0;
      case kCommandQuit:
        if (self->callbacks_.on_quit) self->callbacks_.on_quit();
        return 0;
      default:
        break;
    }
  }

  return ::DefWindowProcW(hwnd, message, w_param, l_param);
}

void TrayIcon::ShowContextMenu() {
  HMENU menu = ::CreatePopupMenu();
  if (!menu) return;
  ::AppendMenuW(menu, MF_STRING, kCommandShow, L"显示 Natalia");
  ::AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  ::AppendMenuW(menu, MF_STRING, kCommandQuit, L"退出");

  // The menu must be sent foreground or the first click outside dismisses it
  // without the shell ever delivering a WM_COMMAND. This is the documented
  // dance; skipping it produces a menu that flashes and vanishes.
  POINT cursor{};
  ::GetCursorPos(&cursor);
  ::SetForegroundWindow(hwnd_);
  ::TrackPopupMenu(menu, TPM_RIGHTBUTTON, cursor.x, cursor.y, 0, hwnd_, nullptr);
  ::PostMessageW(hwnd_, WM_NULL, 0, 0);
  ::DestroyMenu(menu);
}

}  // namespace natalia
