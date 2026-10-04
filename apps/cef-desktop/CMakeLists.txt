cmake_minimum_required(VERSION 3.16)
project(natalia-cef-desktop CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# CEF SDK root: a PER-PLATFORM binary distribution. The three are not
# interchangeable — libcef is a per-platform artifact, and a Linux build linked
# against the Windows distribution (or the reverse) is the bug this split
# exists to prevent. Each default is overridable with -DCEF_ROOT=...
if(WIN32)
  set(_default_cef_root "${CMAKE_CURRENT_SOURCE_DIR}/../../.cef-windows")
elseif(APPLE)
  set(_default_cef_root "${CMAKE_CURRENT_SOURCE_DIR}/../../.cef-macos")
else()
  set(_default_cef_root "${CMAKE_CURRENT_SOURCE_DIR}/../../.cef-test")
endif()
set(CEF_ROOT "${_default_cef_root}" CACHE PATH "CEF SDK root")

# The distributions lay their artifacts out differently per platform:
#   Linux:   include/ + lib/libcef_dll_wrapper.a (the IMPORT library) +
#            bin/libcef.so (the 1.4GB shared object) + bin/*.pak;
#   Windows: include/ + Release/{libcef.lib, libcef.dll, chrome_elf.dll, …}
#            + Resources/ + locales/, and NO prebuilt wrapper: the libcef_dll/
#            sources ship in the distribution and CEF's own cmake integration
#            builds the libcef_dll_wrapper target from them.
# The asymmetry is real and easy to get wrong: on Linux `lib/` holds only
# the wrapper .a while the shared object lives in `bin/`; on Windows the
# prebuilt binaries sit in `Release/`, not at the distribution root, and the
# wrapper must be compiled rather than linked. Assuming symmetry here is a
# link error about a file that exists under a different name.
if(WIN32)
  set(CEF_INCLUDE_DIR "${CEF_ROOT}")
  set(CEF_LIB "${CEF_ROOT}/Release/libcef.lib")
  set(CEF_DLL "${CEF_ROOT}/Release/libcef.dll")
  set(CEF_RUNTIME_DIR "${CEF_ROOT}/Release")
  set(CEF_RESOURCE_DIR "${CEF_ROOT}/Resources")
else()
  set(CEF_INCLUDE_DIR "${CEF_ROOT}/include")
  set(CEF_LIB "${CEF_ROOT}/bin/libcef.so")
  set(CEF_DLL "${CEF_ROOT}/bin/libcef.so")
  set(CEF_WRAPPER_LIB "${CEF_ROOT}/lib/libcef_dll_wrapper.a")
  set(CEF_BINARY_DIR "${CEF_ROOT}/bin")
endif()

# The per-platform sources. Globbing `src/*.cc` would put BOTH entry points in
# one binary (two `main`-family symbols) and would compile the X11 files on
# Windows, so the selection is explicit rather than a glob.
set(NATALIA_CEF_SRCS
  "${CMAKE_CURRENT_SOURCE_DIR}/src/simple_app.cc"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/simple_handler.cc"
)
# The tray detection below needs pkg_check_modules, which comes from CMake's own
# FindPkgConfig module — on LINUX only. Windows finds its tray through
# Shell_NotifyIcon (a Win32 call, always present) and never calls
# pkg_check_modules, so requiring PkgConfig there made `desktop:cef:build:windows`
# fail at configure time on a host that has no pkg-config — a POSIX build tool a
# Windows machine has no reason to carry.
if(NOT WIN32)
  find_package(PkgConfig REQUIRED)
endif()

# The target is created BEFORE the tray detection because the detection calls
# target_include_directories/target_link_libraries/target_compile_definitions on
# it, and CMake requires the target to exist at that point. The source list is
# still being appended to below, which add_executable accepts.
add_executable(natalia-cef-desktop)

# The per-platform sources. Globbing `src/*.cc` would put BOTH entry points in
# one binary (two `main`-family symbols) and would compile the X11 files on
# Windows, so the selection is explicit rather than a glob.
if(WIN32)
  list(APPEND NATALIA_CEF_SRCS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/cefsimple_win.cc"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/simple_handler_win.cc"
    # Shell_NotifyIcon on a private message-only window; links shell32, which
    # every Windows target carries.
    "${CMAKE_CURRENT_SOURCE_DIR}/src/simple_tray_win.cc"
  )
  target_link_libraries(natalia-cef-desktop PRIVATE shell32)

  # The Start Menu entry: a real EXE, not a batch script. A .cmd's `start /b`
  # children share its console, so when the script ended the console closed and
  # took both servers with it — the browser tab it had just opened then failed
  # every API call with ERR_CONNECTION_REFUSED. This launcher starts them with
  # DETACHED_PROCESS, so they outlive it, and it is what the shortcut runs.
  add_executable(natalia-launcher WIN32
    "${CMAKE_CURRENT_SOURCE_DIR}/src/natalia_launcher_win.cc"
  )
  target_link_libraries(natalia-launcher PRIVATE shell32 ws2_32)
  set_target_properties(natalia-launcher PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/output"
  )
else()
# The tray. Both platforms get one, and the difference is a dependency's
# availability rather than a design choice:
#   Windows  Shell_NotifyIcon — Win32, always present, so it is unconditional.
#   Linux    libappindicator — a SYSTEM package, so a machine without it must
#            still build. Both spellings are detected (the original and the
#            maintained Ayatana fork, whose API is identical) and the file is
#            compiled out when neither is found, so the link never fails.
set(NATALIA_HAVE_APPINDICATOR OFF)
# glib is resolved on its own and its two directories are put in the tray's
# `target_include_directories`, because that call is what actually reaches
# `CXX_INCLUDES` (verified by reading the generated flags.make).
#
# Why not let the tray's chain carry it: measured, `_AI_INCLUDE_DIRS` does contain
# two glib directories, and on this machine both are empty of headers —
# `include/glib-2.0` holds neither glib.h nor glibconfig.h. glib's own include is
# split in half (glib.h in one dir, glibconfig.h in a lib-specific one), so a
# `<glib.h>` include fails with a message that names a header, not a path, and the
# directory it names is present.
#
# So: resolve glib separately, and keep only directories that actually contain one
# of the two headers. That is a check on the directory rather than on what some
# other .pc claimed, and it is what makes this survive a prefix that advertises
# include/glib-2.0 with nothing in it.
# glib's two directories are found by asking the FILESYSTEM, not pkg-config.
#
# Measured: `pkg_check_modules(glib-2.0)` on this machine answers with three conda
# directories, and none of the three contains glib.h or glibconfig.h — the printed
# value is [conda/include/glib-2.0; conda/lib/glib-2.0/include; conda/include] while
# the headers are at /usr/include/glib-2.0 and /usr/lib64/glib-2.0/include. Its
# LIBRARY answer is correct (pkgcfg_lib points at /usr/lib64), so include and library
# disagree, and trusting the include half buys a compile failure.
#
# glib's include is split in two, so both are needed and either alone is useless.
# Searching the system prefixes and keeping the first hit of each half is a check
# against the filesystem rather than against what a .pc claimed.
set(_NATALIA_GLIB_PREFIXES /usr /usr/local)
set(_NATALIA_GLIB_DIRS "")
foreach(_p ${_NATALIA_GLIB_PREFIXES})
  foreach(_sub include/glib-2.0 lib64/glib-2.0/include lib/glib-2.0/include include/glib-2.0/include)
    if(EXISTS "${_p}/${_sub}/glib.h")
      list(APPEND _NATALIA_GLIB_DIRS "${_p}/${_sub}")
    endif()
  endforeach()
  foreach(_sub lib64/glib-2.0/include lib/glib-2.0/include include/glib-2.0/include)
    if(EXISTS "${_p}/${_sub}/glibconfig.h")
      list(APPEND _NATALIA_GLIB_DIRS "${_p}/${_sub}")
    endif()
  endforeach()
endforeach()
if(NOT _NATALIA_GLIB_DIRS)
  message(WARNING "glib headers not found under ${_NATALIA_GLIB_PREFIXES}; the tray build will fail on <glib.h>")
endif()
# Both spellings are detected, each TOGETHER with gtk+-3.0: the library's own
# .pc Requires it, and glib's headers arrive through that chain, so checking the
# tray module alone leaves gdkconfig.h unable to find glib.h at compile time.
# Found either, or neither — never a failed link.
set(_AI_CANDIDATES "appindicator3-0.1;ayatana-appindicator3-0.1")
foreach(_pkg ${_AI_CANDIDATES})
  pkg_check_modules(_AI ${_pkg} gtk+-3.0)
  if(_AI_FOUND)
    set(NATALIA_HAVE_APPINDICATOR ON)
    if(${_pkg} STREQUAL ayatana-appindicator3-0.1)
      set(NATALIA_AYATANA_APPINDICATOR ON)
    endif()
    list(APPEND NATALIA_CEF_SRCS "${CMAKE_CURRENT_SOURCE_DIR}/src/simple_tray_linux.cc")
    target_include_directories(natalia-cef-desktop SYSTEM PRIVATE ${_NATALIA_GLIB_DIRS} ${_AI_INCLUDE_DIRS})
    target_link_libraries(natalia-cef-desktop PRIVATE ${_AI_LIBRARIES})
    target_link_directories(natalia-cef-desktop PRIVATE ${_AI_LIBRARY_DIRS})
    target_compile_definitions(natalia-cef-desktop PRIVATE NATALIA_HAVE_APPINDICATOR)
    # The tray's failure path, as a binary that can actually be run.
    #
    # Built here, inside the appindicator branch, because it calls into the tray
    # implementation and so needs the same libraries — building it unconditionally
    # would fail on the machines that have no libappindicator, which are precisely
    # the machines this probe is for. It links the tray privately and prints what it
    # saw rather than asserting one outcome: `--expect-panel` makes it fail when a
    # panel was expected and none came, so the same binary serves both a CI machine
    # and one with a real tray.
    # The implementation travels WITH the probe: it is compiled into the desktop
    # target separately, and a probe that linked only its own translation unit
    # failed on undefined `TrayIcon::Create` — the header declares, the .cc defines.
    add_executable(natalia-tray-probe
      "${CMAKE_CURRENT_SOURCE_DIR}/src/simple_tray_probe.cc"
      "${CMAKE_CURRENT_SOURCE_DIR}/src/simple_tray_linux.cc"
    )
    # The same define the tray implementation is compiled under. The whole header is
    # inside `#if defined(NATALIA_HAVE_APPINDICATOR)`, so without this the probe
    # includes an empty file and fails with "'natalia' has not been declared" — which
    # reads like a namespace typo rather than a missing define.
    target_compile_definitions(natalia-tray-probe PRIVATE NATALIA_HAVE_APPINDICATOR)
    target_include_directories(natalia-tray-probe SYSTEM PRIVATE ${_NATALIA_GLIB_DIRS} ${_AI_INCLUDE_DIRS})
    target_link_libraries(natalia-tray-probe PRIVATE ${_AI_LIBRARIES})
    if(NATALIA_AYATANA_APPINDICATOR)
      target_compile_definitions(natalia-tray-probe PRIVATE NATALIA_AYATANA_APPINDICATOR)
    endif()
    if(NATALIA_AYATANA_APPINDICATOR)
      target_compile_definitions(natalia-cef-desktop PRIVATE NATALIA_AYATANA_APPINDICATOR)
    endif()
    break()
  endif()
endforeach()
  list(APPEND NATALIA_CEF_SRCS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/cefsimple_linux.cc"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/simple_handler_linux.cc"
  )
endif()

# The sources, finished by the tray detection above.
target_sources(natalia-cef-desktop PRIVATE ${NATALIA_CEF_SRCS})

# Windows has no prebuilt wrapper library: CEF's own cmake integration
# (find_package(CEF) + add_subdirectory on libcef_dll/) compiles the
# libcef_dll_wrapper static target from the distribution's sources.
if(WIN32)
  list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
  find_package(CEF REQUIRED)
  # CEF's integration clears CMAKE_CXX_FLAGS* and manages everything through
  # its own variables, so the application target must opt into the same
  # property set (NDEBUG and the rest) or it compiles with a different
  # DCHECK_IS_ON than the wrapper — which is a link error, not a warning.
  # CEF's flag list spells its MSVC requirements (/MP parallel compile, /MT
  # the static CRT). clang-cl refuses both: /MP is an unused argument it
  # errors on under /WX, and /MT fights CMake's own -MD (the CRT libcef.dll
  # was built with). They are filtered here, in the consumer, rather than by
  # patching the downloaded distribution.
  foreach(_cef_flag_var
      CEF_COMPILER_FLAGS CEF_CXX_COMPILER_FLAGS
      CEF_COMPILER_FLAGS_DEBUG CEF_CXX_COMPILER_FLAGS_DEBUG
      CEF_COMPILER_FLAGS_RELEASE CEF_CXX_COMPILER_FLAGS_RELEASE)
    string(REPLACE "/MP" "" ${_cef_flag_var} "${${_cef_flag_var}}")
    string(REPLACE "/MTd" "" ${_cef_flag_var} "${${_cef_flag_var}}")
    string(REPLACE "/MT" "" ${_cef_flag_var} "${${_cef_flag_var}}")
  endforeach()
  add_subdirectory("${CEF_LIBCEF_DLL_WRAPPER_PATH}" "${CMAKE_BINARY_DIR}/libcef_dll_wrapper")
  # clang diagnoses two things MSVC does not: the FARPROC cast Windows makes
  # for every GetProcAddress'd callback (CEF's cef_logging.cc) and partial
  # aggregate initialization in CEF's own internal header. CEF's flag list
  # carries /WX, so they are errors here; they are downgraded to warnings on
  # the wrapper target (CEF's code, not ours).
  target_compile_options(libcef_dll_wrapper PRIVATE
    -Wno-error=cast-function-type-mismatch
    -Wno-error=missing-field-initializers
    -Wno-error=undefined-var-template)
  SET_EXECUTABLE_TARGET_PROPERTIES(natalia-cef-desktop)
  # Our sources include the same CEF headers, so the two clang-vs-MSVC
  # diagnostics downgraded above apply here as well.
  target_compile_options(natalia-cef-desktop PRIVATE
    -Wno-error=cast-function-type-mismatch
    -Wno-error=missing-field-initializers
    -Wno-error=undefined-var-template)
endif()

target_include_directories(natalia-cef-desktop PRIVATE
  "${CEF_INCLUDE_DIR}" "${CEF_ROOT}"
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

# System libraries per platform. dl/pthread/X11 are POSIX-only; Windows'
# libcef.lib already carries its own imports (user32/gdi32), and CEF's own
# samples add nothing else.
if(WIN32)
  target_link_libraries(natalia-cef-desktop PRIVATE
    libcef_dll_wrapper
    "${CEF_LIB}"
    # libcef.lib delay-loads the whole Windows API surface; link.exe would
    # add delayimp.lib implicitly, lld-link needs it named.
    delayimp
  )
  # A GUI-subsystem binary: the entry point is wWinMain, and no console window
  # should appear beside the app.
  set_target_properties(natalia-cef-desktop PROPERTIES
    WIN32_EXECUTABLE TRUE
  )
else()
  target_link_libraries(natalia-cef-desktop PRIVATE
    "${CEF_WRAPPER_LIB}"
    "${CEF_LIB}"
    dl
    pthread
    X11
  )
endif()

set_target_properties(natalia-cef-desktop PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/output"
)

# Copy the CEF runtime next to the executable. The shape differs per platform:
#   Linux: everything the runtime needs sits in bin/ (libcef.so + the .pak
#          files + the snapshot blobs);
#   Windows: the prebuilt runtime sits in Release/ (libcef.dll, chrome_elf.dll,
#            the snapshot blobs, the ANGEL/Vulkan helper DLLs), and
#            Resources/ is a directory beside it.
# Copying only one shape is how "the app builds and then cannot start" happens.
if(WIN32)
  add_custom_command(TARGET natalia-cef-desktop POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CEF_RUNTIME_DIR}" "$<TARGET_FILE_DIR:natalia-cef-desktop>"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CEF_RESOURCE_DIR}" "$<TARGET_FILE_DIR:natalia-cef-desktop>"
    VERBATIM
  )
else()
  add_custom_command(TARGET natalia-cef-desktop POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CEF_BINARY_DIR}" "$<TARGET_FILE_DIR:natalia-cef-desktop>"
    VERBATIM
  )
endif()

# The CEF sandbox is deliberately NOT enabled (CEF_USE_SANDBOX is absent),
# which makes cefsimple's `settings.no_sandbox = true` compile in.
#
# It was defined once, and that was a misconfiguration rather than a
# hardening: this app links libcef_dll_wrapper + libcef.so but NOT
# cef_sandbox, never calls cef_sandbox_initialize, and passes nullptr as
# CefInitialize's sandbox_info. A sandbox that is engaged by definition but
# never initialized leaves the sub-processes under the seccomp policy with
# no broker behind it — the renderer/GPU then fail syscalls with EPERM,
# which surfaced as:
#   ERROR:third_party/puffin/src/puffpatch.cc:122 Failed to create a
#   temporary file for memory-mapping: Operation not permitted
#
# Do not "fix" this back without the whole set: link ${CEF_SANDBOX_LIB},
# call cef_sandbox_initialize in the entry point, pass the result as
# CefInitialize's fourth argument, and ship chrome_sandbox with the
# ownership/permissions a user install cannot grant (root-owned setuid).
# The renderer here renders first-party UI served from the local runtime;
# the product's permission model lives at the tool/approval layer, which
# the renderer sandbox does not touch.
target_compile_definitions(natalia-cef-desktop PRIVATE
  __STDC_CONSTANT_MACROS
  __STDC_FORMAT_MACROS
)
if(WIN32)
  # windows.h's min/max macros otherwise swallow CEF's std::min/std::max
  # uses (a breakage on any Windows host, clang-cl or not).
  target_compile_definitions(natalia-cef-desktop PRIVATE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
else()
  # The LFS knob a POSIX build wants; meaningless (and unused) on Windows.
  target_compile_definitions(natalia-cef-desktop PRIVATE
    _FILE_OFFSET_BITS=64
  )
endif()

# POSIX-only codegen flags. MSVC and clang-cl reject the GCC spellings (and
# clang-cl's driver would pass them through and fail), so they are applied per
# platform.
if(NOT WIN32)
  target_compile_options(natalia-cef-desktop PRIVATE
    -fno-exceptions
    -fno-rtti
    -fno-threadsafe-statics
    -fvisibility=hidden
    -fvisibility-inlines-hidden
  )
endif()
