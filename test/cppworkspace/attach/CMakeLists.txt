cmake_minimum_required(VERSION 3.16)
project(attach)
set(CMAKE_CXX_STANDARD 20)

add_executable(attach ./src/main.cpp)
target_include_directories(attach PUBLIC ../include)

target_compile_options(attach PUBLIC $<$<CONFIG:DEBUG>: ${DEBUG_SETTINGS}>)