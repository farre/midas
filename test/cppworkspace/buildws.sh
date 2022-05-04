#!/bin/bash
last_build_pid=""
projects=("test" "thread" "simple_input" "attach" "rr")
for project in "${projects[@]}"; do
    echo "building $project in Debug and RelWithDebInfo CMake modes..."
    cd "$project"
    mkdir -p build/debug
    mkdir -p build/release
    cd build/debug
    cmake ../.. -DCMAKE_BUILD_TYPE=Debug -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang
    cmake --build . --config Debug &
    cd ../release
    cmake ../.. -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang
    cmake --build . --config RelWithDebInfo &
    last_build_pid="${last_build_pid} $!"
    cd ../../..
done
# wait for all builds to finish.
wait $last_build_pid
echo ""
echo -e "[\x1b[1;44m\x1b[1;32m --- Building all test cases in Debug and RelWithDebInfo: Done --- \x1b[m]"