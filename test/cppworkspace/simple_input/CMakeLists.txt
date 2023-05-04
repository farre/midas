cmake_minimum_required(VERSION 3.16)
project(simple_input)
set(CMAKE_CXX_STANDARD 20)

add_executable(simple_input ./src/main.cpp ./src/todo.cpp)
target_include_directories(simple_input PUBLIC ../include)
target_link_libraries(simple_input pthread)

set(DWARF5_64 -gdwarf-5 -gdwarf64)
target_compile_options(simple_input PUBLIC $<$<CONFIG:DEBUG>:-g3 -gdwarf-5 -gdwarf64 -gfull -gpubnames -gdwarf-aranges>)