#!/bin/bash

projects=("test" "thread")
for project in "${projects[@]}"; do
    echo "building $project ..."
    cd "$project"
    mkdir build
    cd build
    cmake .. -DCMAKE_BUILD_TYPE=Debug
    cmake --build . --config Debug -- -j
    cd ../..
done
