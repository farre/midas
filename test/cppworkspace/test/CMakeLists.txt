cmake_minimum_required(VERSION 3.16)
project(testapp)
set(CMAKE_CXX_STANDARD 20)
set(DWARF5_64 -gdwarf-5 -gdwarf64)
add_executable(testapp ./src/main.cpp ./src/testcase_namespaces/enum.cpp ./src/testcase_namespaces/test_ptrs.cpp ./src/testcase_namespaces/baseclasses.cpp ./src/testcase_namespaces/longstack.cpp ./src/testcase_namespaces/statics.cpp ./src/testcase_namespaces/structrequests.cpp ./src/testcase_namespaces/derive.cpp ./src/todo.cpp ./src/testcase_namespaces/pp.cpp)
target_include_directories(testapp PUBLIC ../include)

target_compile_options(testapp PUBLIC $<$<CONFIG:DEBUG>:-g3 -gdwarf-5 -gdwarf64 -gfull -gpubnames -gdwarf-aranges>)
