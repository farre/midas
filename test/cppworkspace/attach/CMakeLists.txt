cmake_minimum_required(VERSION 3.16)
project(attach)
set(CMAKE_CXX_STANDARD 20)

add_executable(attach ./src/main.cpp)
target_include_directories(attach PUBLIC ../include)

set(DWARF5_64 -gdwarf-5 -gdwarf64)
target_compile_options(attach PUBLIC $<$<CONFIG:DEBUG>:-g3 -gdwarf-5 -gdwarf64 -gfull -gpubnames -gdwarf-aranges>)