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
#   Linux/macOS: include/ + lib/libcef_dll_wrapper.a + bin/libcef.so
#   Windows:     include/ + libcef.lib + libcef_dll_wrapper.lib at the ROOT,
#                with libcef.dll and the .pak files beside them and
#                Resources/ + locales/ as directories.
if(WIN32)
  set(CEF_INCLUDE_DIR "${CEF_ROOT}/include")
  set(CEF_LIB "${CEF_ROOT}/libcef.lib")
  set(CEF_DLL "${CEF_ROOT}/libcef.dll")
  set(CEF_WRAPPER_LIB "${CEF_ROOT}/libcef_dll_wrapper.lib")
  set(CEF_RUNTIME_DIR "${CEF_ROOT}")
else()
  set(CEF_INCLUDE_DIR "${CEF_ROOT}/include")
  set(CEF_LIB "${CEF_ROOT}/lib/libcef.so")
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
if(WIN32)
  list(APPEND NATALIA_CEF_SRCS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/cefsimple_win.cc"
  )
else()
  list(APPEND NATALIA_CEF_SRCS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/cefsimple_linux.cc"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/simple_handler_linux.cc"
  )
endif()

add_executable(natalia-cef-desktop ${NATALIA_CEF_SRCS})

target_include_directories(natalia-cef-desktop PRIVATE
  "${CEF_INCLUDE_DIR}" "${CEF_ROOT}"
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

# System libraries per platform. dl/pthread/X11 are POSIX-only; Windows'
# libcef.lib already carries its own imports (user32/gdi32), and CEF's own
# samples add nothing else.
if(WIN32)
  target_link_libraries(natalia-cef-desktop PRIVATE
    "${CEF_WRAPPER_LIB}"
    "${CEF_LIB}"
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
#   Windows: libcef.dll, chrome_elf.dll, the .pak files and the snapshot blobs
#          sit at the ROOT, and Resources/locales are directories.
# Copying only one shape is how "the app builds and then cannot start" happens.
if(WIN32)
  add_custom_command(TARGET natalia-cef-desktop POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CEF_RUNTIME_DIR}" "$<TARGET_FILE_DIR:natalia-cef-desktop>"
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
  _FILE_OFFSET_BITS=64
  __STDC_CONSTANT_MACROS
  __STDC_FORMAT_MACROS
)

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
