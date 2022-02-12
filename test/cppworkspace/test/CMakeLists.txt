cmake_minimum_required(VERSION 3.16)
project(testapp)
set(CMAKE_CXX_STANDARD 20)

add_executable(testapp ./src/main.cpp ./src/testcase_namespaces/enum.cpp ./src/testcase_namespaces/test_ptrs.cpp ./src/testcase_namespaces/baseclasses.cpp ./src/testcase_namespaces/longstack.cpp ./src/testcase_namespaces/statics.cpp ./src/testcase_namespaces/structrequests.cpp ./src/testcase_namespaces/derive.cpp ./src/todo.cpp)
target_include_directories(testapp PUBLIC ../include)
