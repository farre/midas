#!/bin/bash
mkdir build
cd build
cmake .. -G Ninja
cmake --build .
# place all binaries in cppworkspace/bin/
cmake --install .
