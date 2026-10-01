// Copyright (c) 2014 The Chromium Embedded Framework Authors. All rights
// reserved. Use of this source code is governed by a BSD-style license that
// can be found in the LICENSE file.

#include "simple_handler.h"

#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"

// The Windows half of the platform-specific title change: the browser's
// view carries its window, and the views framework sets the caption. The
// Linux half (simple_handler_linux.cc) goes through X11 atoms instead;
// CMakeLists selects the file per platform so only one is compiled.
void SimpleHandler::PlatformTitleChange(CefRefPtr<CefBrowser> browser,
                                        const CefString& title) {
  CefRefPtr<CefBrowserView> browser_view =
      CefBrowserView::GetForBrowser(browser);
  if (browser_view) {
    CefRefPtr<CefWindow> window = browser_view->GetWindow();
    if (window) {
      window->SetTitle(title);
    }
  }
}
