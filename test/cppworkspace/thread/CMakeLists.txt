cmake_minimum_required(VERSION 3.16)
project(testapp)
set(CMAKE_CXX_STANDARD 20)

add_executable(testapp ./src/main.cpp ./src/todo.cpp)
target_include_directories(testapp PUBLIC ../include)
target_link_libraries(testapp pthread)

target_compile_options(testapp PUBLIC $<$<CONFIG:DEBUG>:${DEBUG_SETTINGS}>)