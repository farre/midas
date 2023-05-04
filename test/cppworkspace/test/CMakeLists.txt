cmake_minimum_required(VERSION 3.16)
project(test)
set(CMAKE_CXX_STANDARD 20)

add_executable(test ./src/main.cpp ./src/testcase_namespaces/enum.cpp ./src/testcase_namespaces/test_ptrs.cpp ./src/testcase_namespaces/baseclasses.cpp ./src/testcase_namespaces/longstack.cpp ./src/testcase_namespaces/statics.cpp ./src/testcase_namespaces/structrequests.cpp ./src/testcase_namespaces/derive.cpp ./src/todo.cpp ./src/testcase_namespaces/pp.cpp ./src/testcase_namespaces/test_freefloating_watch.cpp src/testcase_namespaces/exceptions.cpp)
target_include_directories(test PUBLIC ../include)

target_compile_options(test PUBLIC $<$<CONFIG:DEBUG>:${DEBUG_SETTINGS}>)
