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
if(WIN32)
  list(APPEND NATALIA_CEF_SRCS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/cefsimple_win.cc"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/simple_handler_win.cc"
    # The notification-area icon (Shell_NotifyIcon on a private message-only
    # window). It links shell32, which every Windows target carries.
    "${CMAKE_CURRENT_SOURCE_DIR}/src/simple_tray_win.cc"
  )
  target_link_libraries(natalia-cef-desktop PRIVATE shell32)
else()
  list(APPEND NATALIA_CEF_SRCS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/cefsimple_linux.cc"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/simple_handler_linux.cc"
  )
endif()

add_executable(natalia-cef-desktop ${NATALIA_CEF_SRCS})

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
