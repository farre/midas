#!/bin/bash
mkdir build
cd build
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build .
# place all binaries in cppworkspace/bin/
cmake --install .
cd ..
rm build -rf
