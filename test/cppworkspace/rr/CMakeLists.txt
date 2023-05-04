cmake_minimum_required(VERSION 3.16)
project(rr)
set(CMAKE_CXX_STANDARD 20)

add_executable(buffer_overflow ./buffer_overflow.cpp)
add_executable(segfault ./segfault.cpp)

target_compile_options(buffer_overflow PUBLIC $<$<CONFIG:DEBUG>:${DEBUG_SETTINGS}>)
target_compile_options(segfault PUBLIC $<$<CONFIG:DEBUG>:${DEBUG_SETTINGS}>)