// Copyright (c) 2013 The Chromium Embedded Framework Authors. All rights
// reserved. Use of this source code is governed by a BSD-style license that
// can be found in the LICENSE file.

#ifndef CEF_TESTS_CEFSIMPLE_SIMPLE_APP_H_
#define CEF_TESTS_CEFSIMPLE_SIMPLE_APP_H_

#include "include/cef_app.h"

// The browser-level callbacks each window is created with. Defined in
// simple_app.cc; forward-declared here because a window takes one.
class SimpleHandler;

// Implement application-level callbacks for the browser process.
class SimpleApp : public CefApp, public CefBrowserProcessHandler {
 public:
  SimpleApp();

  // CefApp methods:
  void OnBeforeCommandLineProcessing(
      const CefString& process_type,
      CefRefPtr<CefCommandLine> command_line) override;
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }

  // CefBrowserProcessHandler methods:
  void OnContextInitialized() override;
  // A second launch while this instance runs. The launcher has already
  // found the runtime on 8790 and joined it, so what the new launch is
  // owed is a window: one runtime, several front ends, each doing its
  // own thing. Returning true tells CEF the relaunch was served here.
  bool OnAlreadyRunningAppRelaunch(
      CefRefPtr<CefCommandLine> command_line,
      const CefString& current_directory) override;
  CefRefPtr<CefClient> GetDefaultClient() override;

 private:
  // One window, at a URL, with its own handler. The first window is
  // created from OnContextInitialized; every later one — a second launch
  // against the same runtime — from OnAlreadyRunningAppRelaunch.
  void CreateBrowserWindow(const std::string& url,
                           cef_runtime_style_t runtime_style,
                           CefRefPtr<SimpleHandler> handler);

  // The client the window's browser was created with, set in
  // OnContextInitialized. GetDefaultClient answers with THIS, never with
  // SimpleHandler::GetInstance(): CEF calls it during CefInitialize, before the
  // UI thread exists, and building a handler there is the CHECK that killed
  // every launch. Null until the first window exists is an honest answer.
  CefRefPtr<CefClient> default_client_;

  // Include the default reference counting implementation.
  IMPLEMENT_REFCOUNTING(SimpleApp);
};

#endif  // CEF_TESTS_CEFSIMPLE_SIMPLE_APP_H_
