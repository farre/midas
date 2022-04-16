cmake_minimum_required(VERSION 3.16)
project(testapp)
set(CMAKE_CXX_STANDARD 20)

add_executable(buffer_overflow ./buffer_overflow.cpp)
add_executable(segfault ./segfault.cpp)
