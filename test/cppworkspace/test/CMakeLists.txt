cmake_minimum_required(VERSION 3.16)
project(testapp)
set(CMAKE_CXX_STANDARD 20)

add_executable(testapp ./src/main.cpp ./src/enum.cpp ./src/todo.cpp ./src/test_ptrs.cpp ./src/baseclasses.cpp)
target_include_directories(testapp PUBLIC ../include)
