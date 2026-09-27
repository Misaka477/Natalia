cmake_minimum_required(VERSION 3.16)
project(natalia-cef-desktop CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# CEF SDK root. Default to the local CEF test bundle under .cef-test.
set(CEF_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.cef-test" CACHE PATH "CEF SDK root")
set(CEF_INCLUDE_DIR "${CEF_ROOT}/include")
set(CEF_BINARY_DIR "${CEF_ROOT}/bin")
set(CEF_WRAPPER_LIB "${CEF_ROOT}/lib/libcef_dll_wrapper.a")
set(CEF_LIB "${CEF_BINARY_DIR}/libcef.so")

file(GLOB NATALIA_CEF_SRCS
  "${CMAKE_CURRENT_SOURCE_DIR}/src/*.cc"
)

add_executable(natalia-cef-desktop ${NATALIA_CEF_SRCS})

target_include_directories(natalia-cef-desktop PRIVATE
  "${CEF_INCLUDE_DIR}" "${CEF_ROOT}"
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_link_libraries(natalia-cef-desktop PRIVATE
  "${CEF_WRAPPER_LIB}"
  "${CEF_LIB}"
  dl
  pthread
  X11
)

set_target_properties(natalia-cef-desktop PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/output"
)

# Copy CEF runtime dependencies next to the executable.
add_custom_command(TARGET natalia-cef-desktop POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory
          "${CEF_BINARY_DIR}" "$<TARGET_FILE_DIR:natalia-cef-desktop>"
  VERBATIM
)

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
# call cef_sandbox_initialize in main(), pass the result as
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

target_compile_options(natalia-cef-desktop PRIVATE
  -fno-exceptions
  -fno-rtti
  -fno-threadsafe-statics
  -fvisibility=hidden
  -fvisibility-inlines-hidden
)
