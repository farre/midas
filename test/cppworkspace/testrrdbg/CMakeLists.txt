cmake_minimum_required(VERSION 3.16)
project(testapp)
set(CMAKE_CXX_STANDARD 20)

add_executable(testapp ./src/main.cpp ./src/todo.cpp)
target_include_directories(testapp PUBLIC include)
