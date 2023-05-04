cmake_minimum_required(VERSION 3.16)
project(rr)
set(CMAKE_CXX_STANDARD 20)

add_executable(buffer_overflow ./buffer_overflow.cpp)
add_executable(segfault ./segfault.cpp)

set(DWARF5_64 -gdwarf-5 -gdwarf64)
target_compile_options(buffer_overflow PUBLIC $<$<CONFIG:DEBUG>:-g3 -gdwarf-5 -gdwarf64 -gfull -gpubnames -gdwarf-aranges>)
target_compile_options(segfault PUBLIC $<$<CONFIG:DEBUG>:-g3 -gdwarf-5 -gdwarf64 -gfull -gpubnames -gdwarf-aranges>)