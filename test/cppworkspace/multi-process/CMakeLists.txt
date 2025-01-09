cmake_minimum_required(VERSION 3.16)
project(ForkAndExecListDir)
set(CMAKE_CXX_STANDARD 20)

add_executable(forkexec ./src/main.cpp)
add_executable(listdir ./src/ls.cpp)

target_compile_options(forkexec PUBLIC $<$<CONFIG:DEBUG>:${DEBUG_SETTINGS}>)
target_compile_options(listdir PUBLIC $<$<CONFIG:DEBUG>:${DEBUG_SETTINGS}>)