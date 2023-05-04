cmake_minimum_required(VERSION 3.20)
project(cppworkspace)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/../bin)

set(DEBUG_SETTINGS -g3)

add_subdirectory(attach)
add_subdirectory(rr)
add_subdirectory(simple_input)
add_subdirectory(test)
add_subdirectory(thread)

# install(TARGETS attach CONFIGURATIONS Debug RUNTIME DESTINATION ${CMAKE_BINARY_DIR}/../bin)